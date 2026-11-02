import Foundation
import AVFoundation

/// The one owner of CallPilot's audio session, so listening and the keep-alive never fight over it.
///
/// iOS keeps an app with the "audio" background mode running while its audio session is in use. CallPilot
/// uses that two ways: while a meeting is being listened to (the microphone is in use), and, when only the
/// desktop link is on, by playing a loop of pure silence. Either way the phone can lock and CallPilot keeps
/// working, which is what lets notes reach the glasses from a phone in a pocket.
final class CPAudio {
    static let shared = CPAudio()

    private(set) var listening = false
    private var silentPlayer: AVAudioPlayer?

    var keepingAlive: Bool { silentPlayer != nil }

    /// Sets the session up for what is needed right now and makes it active (or lets it go when nothing is).
    private func apply() throws {
        let session = AVAudioSession.sharedInstance()
        if listening {
            // Record from the iPhone's own microphone. Bluetooth headsets (glasses included) stay output-only,
            // so they never take over as the meeting microphone. Other apps' audio keeps playing.
            try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP])
            try session.setActive(true, options: [])
        } else if silentPlayer != nil {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true, options: [])
        } else {
            try? session.setActive(false, options: [.notifyOthersOnDeactivation])
        }
    }

    func setListening(_ on: Bool) throws {
        listening = on
        try apply()
    }

    /// Plays silence on a loop (or stops it). Nothing is audible; it only keeps the app awake.
    func setKeepAlive(_ on: Bool) {
        if on {
            if silentPlayer == nil {
                guard let player = try? AVAudioPlayer(data: CPAudio.silentWav()) else { return }
                player.numberOfLoops = -1
                player.volume = 0.01
                silentPlayer = player
                try? apply()
                player.prepareToPlay()
                player.play()
            } else if silentPlayer?.isPlaying == false {
                try? apply()
                silentPlayer?.play()
            }
        } else if let player = silentPlayer {
            player.stop()
            silentPlayer = nil
            try? apply()
        }
    }

    /// Picks the silence back up after something (a phone call, Siri) interrupted it.
    func resumeAfterInterruption() {
        guard let player = silentPlayer, !player.isPlaying else { return }
        try? apply()
        player.play()
    }

    /// One second of 16-bit mono silence as a WAV file.
    private static func silentWav() -> Data {
        let rate: UInt32 = 8000
        let samples = Int(rate)
        let dataBytes = UInt32(samples * 2)
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + dataBytes)
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(dataBytes)
        d.append(Data(count: Int(dataBytes)))
        return d
    }
}
