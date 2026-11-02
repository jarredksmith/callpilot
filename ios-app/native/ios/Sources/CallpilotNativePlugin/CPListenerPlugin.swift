import Foundation
import AVFoundation
import Speech
import UIKit
import Capacitor

/// One stretch of speech being turned into text. A new one starts at every pause, so each finished
/// segment becomes one transcript line, while the microphone keeps running without a gap.
private final class Segment {
    let request: SFSpeechAudioBufferRecognitionRequest
    var task: SFSpeechRecognitionTask?
    var text = ""
    let startedAt = Date()
    var lastChange = Date()
    var done = false
    init(request: SFSpeechAudioBufferRecognitionRequest) { self.request = request }
}

/// CallPilot's native listener: the iPhone's own speech recognition, on the phone, fed straight from the
/// microphone. Unlike the web version it makes no "bip" sounds, never needs restarting, and keeps going
/// with the screen locked (the app has the "audio" background mode).
///
/// Events: "text" {text, at (ms since 1970, when the line started)}, "interim" {text}, "voice",
///         "state" {state: listening|interrupted|stopped, message}, "fatal" {message}
@objc(CPListenerPlugin)
public class CPListenerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CPListenerPlugin"
    public let jsName = "CPListener"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "flush", returnType: CAPPluginReturnPromise)
    ]

    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var onDevice = true
    private var vocab: [String] = []
    private var pauseSeconds = 1.3

    private var running = false
    private var interrupted = false
    private var tapInstalled = false
    private var current: Segment?
    private var live: [Segment] = []            // segments still waiting for their final text
    private let tapLock = NSLock()
    private var tapRequest: SFSpeechAudioBufferRecognitionRequest?   // read on the audio thread
    private var watch: Timer?
    private var quickFailures = 0
    private var lastInterim = ""
    private var lastRestart = Date.distantPast
    private var retryScheduled = false
    private var observers: [NSObjectProtocol] = []

    // MARK: - JS methods

    @objc func status(_ call: CAPPluginCall) {
        let lang = call.getString("lang") ?? ""
        DispatchQueue.main.async {
            let rec = self.makeRecognizer(lang)
            let speech: String
            switch SFSpeechRecognizer.authorizationStatus() {
            case .authorized: speech = "granted"
            case .denied, .restricted: speech = "denied"
            default: speech = "prompt"
            }
            let mic: String
            switch AVAudioSession.sharedInstance().recordPermission {
            case .granted: mic = "granted"
            case .denied: mic = "denied"
            default: mic = "prompt"
            }
            call.resolve([
                "available": rec?.isAvailable ?? false,
                "onDevice": rec?.supportsOnDeviceRecognition ?? false,
                "speech": speech,
                "mic": mic,
                "running": self.running,
                "interrupted": self.interrupted
            ])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        let lang = call.getString("lang") ?? ""
        let words = (call.getArray("vocab") as? [String]) ?? []
        let pause = call.getDouble("pause") ?? 1.3
        let wantOnDevice = call.getBool("onDevice") ?? true
        DispatchQueue.main.async {
            if self.running { call.resolve(["onDevice": self.onDevice]); return }
            guard let rec = self.makeRecognizer(lang) else {
                call.reject("iPhone speech recognition doesn't support this language. Pick another language in Settings, or use Whisper.")
                return
            }
            self.authorize { ok, message in
                guard ok else { call.reject(message); return }
                rec.queue = OperationQueue.main
                self.recognizer = rec
                self.onDevice = wantOnDevice && rec.supportsOnDeviceRecognition
                self.vocab = Array(words.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.prefix(100))
                self.pauseSeconds = max(0.6, min(4.0, pause))
                do {
                    try self.begin()
                    call.resolve(["onDevice": self.onDevice])
                } catch {
                    self.halt()
                    call.reject("Couldn't start the microphone: \(error.localizedDescription)")
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.running else { call.resolve(); return }
            self.setTapRequest(nil)
            if let seg = self.current { self.current = nil; seg.request.endAudio() }
            self.halt()
            // give the last words a moment to come back before saying we're done
            self.waitForLast(until: Date().addingTimeInterval(2.5)) {
                self.notifyListeners("state", data: ["state": "stopped"])
                call.resolve()
            }
        }
    }

    /// Ends the current line now (for long stretches with no pause), without stopping.
    @objc func flush(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.running, let seg = self.current, !seg.text.isEmpty { self.rotate() }
            call.resolve()
        }
    }

    // MARK: - Setup

    private func makeRecognizer(_ lang: String) -> SFSpeechRecognizer? {
        if lang.isEmpty || lang == "auto" { return SFSpeechRecognizer() }
        return SFSpeechRecognizer(locale: Locale(identifier: lang))
    }

    private func authorize(_ done: @escaping (Bool, String) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else {
                    done(false, "Speech recognition isn't allowed. Turn it on in iPhone Settings > CallPilot.")
                    return
                }
                AVAudioSession.sharedInstance().requestRecordPermission { granted in
                    DispatchQueue.main.async {
                        done(granted, granted ? "" : "Microphone access isn't allowed. Turn it on in iPhone Settings > CallPilot.")
                    }
                }
            }
        }
    }

    private func begin() throws {
        try CPAudio.shared.setListening(true)
        try startEngine()
        running = true
        interrupted = false
        quickFailures = 0
        newSegment()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in self?.watchdog() }
        RunLoop.main.add(timer, forMode: .common)
        watch = timer
        addObservers()
        notifyListeners("state", data: ["state": "listening"])
    }

    private func startEngine() throws {
        let input = engine.inputNode
        if tapInstalled { input.removeTap(onBus: 0); tapInstalled = false }
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "CallPilot", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone is available right now"])
        }
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let self = self else { return }
            self.tapLock.lock()
            let request = self.tapRequest
            self.tapLock.unlock()
            request?.append(buffer)
        }
        tapInstalled = true
        engine.prepare()
        try engine.start()
    }

    /// Stops the microphone and everything around it (segments still finishing are left to finish).
    private func halt() {
        running = false
        interrupted = false
        watch?.invalidate()
        watch = nil
        setTapRequest(nil)
        if engine.isRunning { engine.stop() }
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        removeObservers()
        try? CPAudio.shared.setListening(false)
        sendInterim()
    }

    private func setTapRequest(_ request: SFSpeechAudioBufferRecognitionRequest?) {
        tapLock.lock()
        tapRequest = request
        tapLock.unlock()
    }

    // MARK: - Segments

    private func newSegment() {
        guard running, !interrupted, let rec = recognizer else { return }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if onDevice { request.requiresOnDeviceRecognition = true }
        if #available(iOS 16.0, *) { request.addsPunctuation = true }
        if !vocab.isEmpty { request.contextualStrings = vocab }
        let seg = Segment(request: request)
        current = seg
        live.append(seg)
        setTapRequest(request)
        seg.task = rec.recognitionTask(with: request) { [weak self, weak seg] result, error in
            guard let self = self, let seg = seg else { return }
            if Thread.isMainThread { self.handle(seg, result, error) }
            else { DispatchQueue.main.async { self.handle(seg, result, error) } }
        }
    }

    private func handle(_ seg: Segment, _ result: SFSpeechRecognitionResult?, _ error: Error?) {
        if seg.done { return }
        if let result = result {
            let text = result.bestTranscription.formattedString.trimmingCharacters(in: .whitespacesAndNewlines)
            if text != seg.text {
                seg.text = text
                seg.lastChange = Date()
                notifyListeners("voice", data: [:])
                sendInterim()
            }
            if result.isFinal {
                finish(seg)
                if seg === current { current = nil; newSegment() }
                return
            }
        }
        guard error != nil else { return }
        finish(seg)
        guard seg === current else { return }
        // The recognizer gave up on the live segment (a long silence, a time limit, a glitch): start a fresh
        // one. If that keeps failing straight away, back off and eventually tell the app.
        current = nil
        setTapRequest(nil)
        if Date().timeIntervalSince(seg.startedAt) > 3 || !seg.text.isEmpty { quickFailures = 0 } else { quickFailures += 1 }
        if quickFailures >= 25 {
            let message = (error as NSError?)?.localizedDescription ?? "unknown error"
            halt()
            notifyListeners("fatal", data: ["message": "iPhone speech recognition keeps failing (\(message))."])
            return
        }
        let delay = quickFailures < 3 ? 0.05 : min(5.0, 0.5 * Double(quickFailures))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, self.running, self.current == nil else { return }
            self.newSegment()
        }
    }

    /// The segment is over: its text becomes a transcript line.
    private func finish(_ seg: Segment) {
        guard !seg.done else { return }
        seg.done = true
        seg.task = nil
        live.removeAll { $0 === seg }
        if !seg.text.isEmpty {
            notifyListeners("text", data: ["text": seg.text, "at": seg.startedAt.timeIntervalSince1970 * 1000])
        }
        sendInterim()
    }

    /// Ends the current segment and starts the next one straight away, so nothing said is missed.
    private func rotate() {
        guard let seg = current else { return }
        current = nil
        newSegment()
        seg.request.endAudio()
        // if the final text never comes back, keep what was heard
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self, weak seg] in
            guard let self = self, let seg = seg, !seg.done else { return }
            seg.task?.cancel()
            self.finish(seg)
        }
    }

    private func watchdog() {
        guard running, !interrupted else { return }
        guard let seg = current else { return }
        let now = Date()
        let quiet = now.timeIntervalSince(seg.lastChange)
        let age = now.timeIntervalSince(seg.startedAt)
        if !seg.text.isEmpty && quiet >= pauseSeconds {
            rotate()                                   // a pause: the line is done
        } else if seg.text.count > 500 || age > 55 {
            rotate()                                   // a long monologue, or the recognizer's time limit
        }
    }

    private func sendInterim() {
        let text = live.filter { !$0.done && !$0.text.isEmpty }.map { $0.text }.joined(separator: " ")
        if text == lastInterim { return }
        lastInterim = text
        notifyListeners("interim", data: ["text": text])
    }

    private func waitForLast(until deadline: Date, then done: @escaping () -> Void) {
        if live.allSatisfy({ $0.done }) || Date() > deadline {
            for seg in live where !seg.done {
                seg.task?.cancel()
                finish(seg)
            }
            live.removeAll()
            done()
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.waitForLast(until: deadline, then: done)
        }
    }

    // MARK: - Interruptions (phone calls, Siri, route changes)

    private func addObservers() {
        removeObservers()
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            self?.onInterruption(note)
        })
        observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.restart()
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            self?.restart()
        })
        observers.append(nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self = self, self.running else { return }
            if self.interrupted || !self.engine.isRunning { self.restart() }
        })
    }

    private func removeObservers() {
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers.removeAll()
    }

    private func onInterruption(_ note: Notification) {
        guard running,
              let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            interrupted = true
            if let seg = current { current = nil; setTapRequest(nil); seg.request.endAudio() }
            notifyListeners("state", data: ["state": "interrupted", "message": "Listening paused by the iPhone (a call or Siri)."])
        } else {
            restart()
        }
    }

    /// Gets the microphone going again after an interruption or an audio route change.
    private func restart() {
        guard running else { return }
        if Date().timeIntervalSince(lastRestart) < 0.8 {
            scheduleRetry(after: 1.0)
            return
        }
        lastRestart = Date()
        if engine.isRunning { engine.stop() }
        if let seg = current { current = nil; setTapRequest(nil); seg.request.endAudio() }
        do {
            try CPAudio.shared.setListening(true)
            try startEngine()
            let wasInterrupted = interrupted
            interrupted = false
            newSegment()
            if wasInterrupted { notifyListeners("state", data: ["state": "listening"]) }
        } catch {
            interrupted = true
            notifyListeners("state", data: ["state": "interrupted", "message": "Couldn't get the microphone back yet (\(error.localizedDescription)). Trying again."])
            scheduleRetry(after: 4.0)
        }
    }

    private func scheduleRetry(after seconds: Double) {
        if retryScheduled { return }
        retryScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self = self else { return }
            self.retryScheduled = false
            if self.running && (self.interrupted || !self.engine.isRunning) { self.restart() }
        }
    }
}
