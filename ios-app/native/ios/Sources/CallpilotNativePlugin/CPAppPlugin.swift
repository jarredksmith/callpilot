import Foundation
import UIKit
import AVFoundation
import WebKit
import Capacitor

/// Keeps CallPilot working while the phone is locked or another app is on screen.
///
/// Two parts: the app itself is kept running by its audio session (the meeting microphone, or a loop of
/// silence when only the desktop link is on), and the page inside it is kept awake by a "pump": while the
/// app is in the background, it keeps asking the page to do its work (window.__cpPump), which iOS honours
/// even for a page it would otherwise pause.
///
/// Events: "appState" {active}
@objc(CPAppPlugin)
public class CPAppPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CPAppPlugin"
    public let jsName = "CPApp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "keepAlive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepScreenOn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise)
    ]

    private var keepOn = false
    private var pumpTimer: Timer?
    private var pumping = false
    private var pumpStarted = Date.distantPast
    private var pumpsInBackground = 0
    private var backgroundSince: Date?

    override public func load() {
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(willEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(audioInterrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
    }

    // MARK: - JS methods

    /// on: keep working in the background. silentAudio: also keep the app awake with silence (needed when
    /// the microphone isn't running, e.g. for the desktop link on its own).
    @objc func keepAlive(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        let silent = call.getBool("silentAudio") ?? false
        DispatchQueue.main.async {
            self.keepOn = on
            CPAudio.shared.setKeepAlive(on && silent)
            if on && self.pumpTimer == nil {
                let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in self?.pump() }
                RunLoop.main.add(timer, forMode: .common)
                self.pumpTimer = timer
            } else if !on {
                self.pumpTimer?.invalidate()
                self.pumpTimer = nil
            }
            call.resolve(["keepingAlive": CPAudio.shared.keepingAlive])
        }
    }

    @objc func keepScreenOn(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve()
        }
    }

    @objc func info(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let bundle = Bundle.main
            call.resolve([
                "active": UIApplication.shared.applicationState == .active,
                "version": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
                "build": bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
                "keepingAlive": CPAudio.shared.keepingAlive,
                "pumpsInBackground": self.pumpsInBackground
            ])
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            call.resolve()
        }
    }

    // MARK: - Background

    @objc private func didEnterBackground() {
        backgroundSince = Date()
        pumpsInBackground = 0
        notifyListeners("appState", data: ["active": false])
    }

    @objc private func willEnterForeground() {
        let away = backgroundSince.map { Date().timeIntervalSince($0) } ?? 0
        backgroundSince = nil
        notifyListeners("appState", data: ["active": true, "away": away, "pumps": pumpsInBackground])
    }

    @objc private func audioInterrupted(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { CPAudio.shared.resumeAfterInterruption() }
    }

    /// While in the background, keep the page busy: each call runs the page's own timers and requests and
    /// returns after a few seconds, then the next one starts.
    private func pump() {
        guard keepOn, UIApplication.shared.applicationState != .active else { return }
        if pumping {
            if Date().timeIntervalSince(pumpStarted) < 90 { return }
            pumping = false                       // a call that never came back: try again
        }
        guard let webView = bridge?.webView else { return }
        pumping = true
        pumpStarted = Date()
        webView.callAsyncJavaScript("return window.__cpPump ? await window.__cpPump() : 0", arguments: [:], in: nil, in: .page) { [weak self] _ in
            guard let self = self else { return }
            self.pumping = false
            if self.backgroundSince != nil { self.pumpsInBackground += 1 }
        }
    }
}
