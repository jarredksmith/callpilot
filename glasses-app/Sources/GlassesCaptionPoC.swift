//
//  GlassesCaptionPoC.swift
//  RayNeo iO — caption-channel display proof of concept (iPhone / Core Bluetooth)
//
//  WHAT THIS DOES
//  --------------
//  Connects directly to the RayNeo iO glasses over BLE (no RayNeo app needed),
//  then pushes your own text onto the glasses display using the "AI subtitle"
//  (live caption) channel. This is the fastest validation that the glasses
//  firmware will render text we send ourselves.
//
//  Everything about the wire format below was reverse-engineered from a Bluetooth
//  HCI capture of the real RayNeo app and verified byte-for-byte (the CRC check
//  passed on all 63 framed packets in the capture).
//
//  HOW TO USE
//  ----------
//  Built by .github/workflows/glasses.yml and installed from TestFlight ("Glasses").
//  1. Tap "Find connected" (works while the RayNeo app holds the glasses), or
//     disconnect the glasses in iOS Settings > Bluetooth and tap "Scan".
//  2. Tap "Connect: RayNeo iO-…" and wait for status "ready". The log lists every
//     service/characteristic the glasses expose.
//  3. "Open session", then "Send A" / "Send B". Watch the glasses and the RX lines.
//  4. "Copy log" puts the whole log on the clipboard to paste back to Claude.
//
//  IF TEXT DOESN'T APPEAR
//  ----------------------
//  The framing + channel are confirmed. The remaining unknown is the exact
//  caption "state" token / message type that makes text render. The two most
//  likely sequences are both wired up below (see sendCaption). Try button A,
//  then button B, and read the glasses' notify replies in the log — they tell
//  us which the firmware accepts. This is the one thing that needs on-device
//  iteration; the transport is solid.
//

import SwiftUI
import UIKit
import CoreBluetooth

// MARK: - RayNeo wire protocol ------------------------------------------------

enum RNProto {
    // Characteristics discovered in the capture.
    static let writeChar  = CBUUID(string: "ea8b70d5-2bd3-49ab-9c31-9c38b2c3c4f9") // phone -> glasses
    static let notifyChar = CBUUID(string: "7db3e235-3608-41f3-a03c-955fcbd2ea4b") // glasses -> phone

    // Business channels (the byte after the flags).
    static let chTeleprompter: UInt8 = 0x14
    static let chCaption:      UInt8 = 0x13   // "AI_SUBTITLE"
    static let chNotification: UInt8 = 0x15

    // CRC-16/CCITT (XModem): poly 0x1021, init 0x0000. Table built exactly as the
    // app's C4389b class does it.
    static let crcTable: [UInt16] = {
        var t = [UInt16](repeating: 0, count: 256)
        for i in 0..<256 {
            var c = UInt16(i) << 8
            for _ in 0..<8 {
                c = (c & 0x8000) != 0 ? (c << 1) ^ 0x1021 : (c << 1)
            }
            t[i] = c
        }
        return t
    }()

    static func crc16(_ bytes: ArraySlice<UInt8>) -> UInt16 {
        var c: UInt16 = 0
        for b in bytes {
            let idx = Int((c >> 8) ^ UInt16(b)) & 0xFF
            c = (c << 8) ^ crcTable[idx]
        }
        return c
    }

    /// Frame a payload into a full AA55 packet for a given channel.
    /// Layout: AA 55 | len(2 BE) | seq(2 BE) | flags(1=0x00) | channel(1) | payload | crc(2 BE)
    /// `len` and the CRC both cover everything from the seq field through the payload.
    static func frame(channel: UInt8, seq: UInt16, payload: [UInt8]) -> [UInt8] {
        var region: [UInt8] = []
        region.append(UInt8(seq >> 8))
        region.append(UInt8(seq & 0xFF))
        region.append(0x00)            // flags = 0 (no optional byte, no extra data)
        region.append(channel)
        region.append(contentsOf: payload)

        let len = UInt16(region.count)
        let crc = crc16(region[region.startIndex..<region.endIndex])

        var pkt: [UInt8] = [0xAA, 0x55, UInt8(len >> 8), UInt8(len & 0xFF)]
        pkt.append(contentsOf: region)
        pkt.append(UInt8(crc >> 8))
        pkt.append(UInt8(crc & 0xFF))
        return pkt
    }

    // Minimal protobuf encoder for the message body:
    //   field 1 (version)  = varint
    //   field 2 (type)     = varint
    //   field 3 (message)  = length-delimited UTF-8 string (the JSON)
    static func varint(_ v: Int) -> [UInt8] {
        var out: [UInt8] = []; var n = v
        repeat { var b = UInt8(n & 0x7F); n >>= 7; if n != 0 { b |= 0x80 }; out.append(b) } while n != 0
        return out
    }

    static func messageBody(version: Int, type: Int, json: String, data: [UInt8] = []) -> [UInt8] {
        var out: [UInt8] = []
        out.append(0x08); out.append(contentsOf: varint(version))            // field 1: version
        out.append(0x10); out.append(contentsOf: varint(type))               // field 2: type
        let s = Array(json.utf8)
        out.append(0x1A); out.append(contentsOf: varint(s.count)); out.append(contentsOf: s) // field 3: message (JSON)
        out.append(0x22); out.append(contentsOf: varint(data.count)); out.append(contentsOf: data) // field 4: data
        // NOTE: the real app always serializes field 4 (data), empty -> "22 00".
        // Verified: with this appended, our frames reproduce the captured packets byte-for-byte (CRC included).
        return out
    }

    /// Decode an incoming AA55 frame enough to log channel + type + JSON.
    static func describe(_ data: [UInt8]) -> String {
        guard data.count >= 10, data[0] == 0xAA, data[1] == 0x55 else {
            return "raw " + data.map { String(format: "%02x", $0) }.joined()
        }
        let len = Int(data[2]) << 8 | Int(data[3])
        let seq = Int(data[4]) << 8 | Int(data[5])
        let flags = data[6]
        var idx = 7
        if flags & 0x02 != 0 { idx += 1 }            // optional byte
        let extra = Int((flags >> 5) & 0x07)
        idx += extra
        guard idx < data.count else { return "short" }
        let chan = data[idx]; idx += 1
        let payLen = len - (3 + (flags & 0x02 != 0 ? 1 : 0) + extra + 1)
        let end = min(idx + max(payLen, 0), data.count)
        let pay = Array(data[idx..<end])
        // pull field2 (type) and field3 (string) out of the protobuf
        var t = -1, msg = ""
        var i = 0
        while i < pay.count {
            let tag = pay[i]; i += 1
            let field = tag >> 3, wire = tag & 7
            if wire == 0 {
                var v = 0, sh = 0
                while i < pay.count { let b = pay[i]; i += 1; v |= Int(b & 0x7F) << sh; if b & 0x80 == 0 { break }; sh += 7 }
                if field == 2 { t = v }
            } else if wire == 2 {
                var l = 0, sh = 0
                while i < pay.count { let b = pay[i]; i += 1; l |= Int(b & 0x7F) << sh; if b & 0x80 == 0 { break }; sh += 7 }
                let e = min(i + l, pay.count)
                if field == 3 { msg = String(bytes: pay[i..<e], encoding: .utf8) ?? "" }
                i = e
            } else { break }
        }
        return "seq=\(seq) chan=0x\(String(chan, radix:16)) type=\(t) \(msg)"
    }
}

// MARK: - BLE manager ---------------------------------------------------------

final class GlassesBLE: NSObject, ObservableObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    @Published var status = "idle"
    @Published var log: [String] = []
    @Published var connected = false
    @Published var found: [CBPeripheral] = []

    private var central: CBCentralManager!
    private var glasses: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var seq: UInt16 = 1
    private let captionSid = "900001"   // our own session id; the app used a dummy like "123456"

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    private func line(_ s: String) {
        log.insert(s, at: 0)
        if log.count > 200 { log.removeLast() }
    }

    func scan() {
        found.removeAll()
        guard central.state == .poweredOn else { line("Bluetooth not ready: \(central.state.rawValue)"); return }
        status = "scanning"
        central.scanForPeripherals(withServices: nil, options: nil)
        line("scanning for RayNeo…")
    }

    func connect(_ p: CBPeripheral) {
        central.stopScan()
        glasses = p; p.delegate = self
        status = "connecting"
        UserDefaults.standard.set(p.identifier.uuidString, forKey: "lastGlassesID")
        central.connect(p, options: nil)
    }

    /// Glasses that are already connected to the iPhone (e.g. by the RayNeo app) stop
    /// advertising, so Scan can't see them. iOS can still hand them to us if we know
    /// their identifier (saved after a previous connect) or one of their services.
    func findConnected() {
        guard central.state == .poweredOn else { line("Bluetooth not ready"); return }
        var hits: [CBPeripheral] = []
        if let s = UserDefaults.standard.string(forKey: "lastGlassesID"), let id = UUID(uuidString: s) {
            hits += central.retrievePeripherals(withIdentifiers: [id])
        }
        var candidates = [CBUUID(string: "180A"), CBUUID(string: "180F"), CBUUID(string: "FFF0")]
        if let s = UserDefaults.standard.string(forKey: "vendorService") { candidates.insert(CBUUID(string: s), at: 0) }
        hits += central.retrieveConnectedPeripherals(withServices: candidates)
        for p in hits where !found.contains(where: { $0.identifier == p.identifier }) {
            found.append(p)
            line("already-known: \(p.name ?? "?") state \(p.state.rawValue)")
        }
        if hits.isEmpty { line("no already-connected glasses found; disconnect them in iOS Settings > Bluetooth and use Scan") }
    }

    func copyLog() {
        UIPasteboard.general.string = log.reversed().joined(separator: "\n")
        line("log copied to clipboard")
    }

    private func nextSeq() -> UInt16 { defer { seq &+= 1 }; return seq }

    private func send(channel: UInt8, body: [UInt8], note: String) {
        guard let p = glasses, let ch = writeCharacteristic else { line("not connected"); return }
        let pkt = RNProto.frame(channel: channel, seq: nextSeq(), payload: body)
        // The RayNeo app used Write Without Response (ATT 0x52); fall back if unsupported.
        let type: CBCharacteristicWriteType = ch.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
        let maxLen = p.maximumWriteValueLength(for: type)
        if pkt.count > maxLen {
            line("WARNING packet \(pkt.count) bytes > link max \(maxLen); glasses may drop it")
        }
        p.writeValue(Data(pkt), for: ch, type: type)
        line("TX \(note) [\(pkt.count)B \(type == .withoutResponse ? "noResp" : "resp")]: "
             + pkt.map { String(format:"%02x",$0) }.joined())
    }

    // --- Caption API. Two candidate "make text show" sequences. ---

    /// Candidate A - session state message (mirrors the app's captured type-11
    ///    message), carrying the text directly.
    func sendCaptionStateText(_ text: String) {
        let esc = text.replacingOccurrences(of: "\"", with: "\\\"")
        let json = "{\"sid\":\"\(captionSid)\",\"state\":\"working\",\"text\":\"\(esc)\"}"
        send(channel: RNProto.chCaption,
             body: RNProto.messageBody(version: 1, type: 11, json: json),
             note: "caption type11")
    }

    /// Candidate B - caption content message (mirrors the app's code path: type 5
    ///    with a content object holding source_transcript / target_translation).
    func sendCaptionContent(_ text: String) {
        let esc = text.replacingOccurrences(of: "\"", with: "\\\"")
        let json = "{\"sid\":\"\(captionSid)\",\"mode\":0,\"status\":1,"
                 + "\"content\":{\"source_transcript\":\"\(esc)\","
                 + "\"target_translation\":\"\",\"label\":0,\"keyword_info\":\"\"}}"
        send(channel: RNProto.chCaption,
             body: RNProto.messageBody(version: 1, type: 5, json: json),
             note: "caption type5")
    }

    /// Open an idle caption session first (exactly what the app sent at startup).
    func openCaptionSession() {
        let json = "{\"sid\":\"\(captionSid)\",\"state\":\"idle\",\"text\":\"\"}"
        send(channel: RNProto.chCaption,
             body: RNProto.messageBody(version: 1, type: 11, json: json),
             note: "caption open(idle)")
    }

    // MARK: CBCentralManagerDelegate
    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        line("central state: \(c.state.rawValue) (5=poweredOn)")
    }

    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData: [String : Any], rssi RSSI: NSNumber) {
        let name = p.name ?? (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? ""
        guard name.lowercased().contains("rayneo") || name.lowercased().contains("io-") else { return }
        if !found.contains(where: { $0.identifier == p.identifier }) {
            found.append(p)
            line("found: \(name) rssi \(RSSI)")
        }
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        status = "discovering"; connected = true
        line("connected, discovering services…")
        p.discoverServices(nil)
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        status = "connect failed"; line("connect failed: \(error?.localizedDescription ?? "?")")
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        status = "disconnected"; connected = false; writeCharacteristic = nil
        line("disconnected: \(error?.localizedDescription ?? "clean")")
    }

    // MARK: CBPeripheralDelegate
    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        if let e = error { line("service discovery error: \(e.localizedDescription)") }
        for s in p.services ?? [] {
            line("service \(s.uuid.uuidString)")
            p.discoverCharacteristics(nil, for: s)
        }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        for ch in s.characteristics ?? [] {
            line("  char \(ch.uuid.uuidString) props 0x\(String(ch.properties.rawValue, radix: 16))")
            if ch.uuid == RNProto.writeChar {
                writeCharacteristic = ch
                status = "ready"
                UserDefaults.standard.set(s.uuid.uuidString, forKey: "vendorService")
                line("write characteristic ready (service \(s.uuid.uuidString)); max write \(p.maximumWriteValueLength(for: .withoutResponse))B")
            }
            // Subscribe to EVERY notify/indicate characteristic. For the glasses this
            // is the reply channel; for any other device (e.g. a BLE remote/ring) this
            // sniffs whatever it reports — press buttons and watch the RX lines.
            if ch.properties.contains(.notify) || ch.properties.contains(.indicate) {
                p.setNotifyValue(true, for: ch)
                if ch.uuid == RNProto.notifyChar { line("subscribing to glasses replies…") }
            }
        }
    }

    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor ch: CBCharacteristic, error: Error?) {
        if let e = error { line("notify subscribe error: \(e.localizedDescription)") }
        else { line("notify on for \(ch.uuid.uuidString): \(ch.isNotifying)") }
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor ch: CBCharacteristic, error: Error?) {
        line(error == nil ? "write acknowledged" : "write error: \(error!.localizedDescription)")
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        guard let d = ch.value else { return }
        let bytes = [UInt8](d)
        if ch.uuid == RNProto.notifyChar {
            line("RX " + RNProto.describe(bytes))      // glasses: decode the AA55 frame
        } else {
            // any other characteristic (e.g. the ring's AE channels): raw bytes
            let hex = bytes.map { String(format: "%02x", $0) }.joined(separator: " ")
            line("RX \(ch.uuid.uuidString) [\(bytes.count)B]: \(hex)")
        }
    }
}

// MARK: - UI ------------------------------------------------------------------

struct ContentView: View {
    @StateObject var ble = GlassesBLE()
    @State var text = "Hello from my own app"

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("RayNeo iO caption PoC").font(.headline)
            Text("status: \(ble.status)").font(.caption).foregroundColor(.secondary)

            HStack {
                Button("Scan") { ble.scan() }.buttonStyle(.borderedProminent)
                Button("Find connected") { ble.findConnected() }.buttonStyle(.bordered)
                Button("Copy log") { ble.copyLog() }.buttonStyle(.bordered)
            }
            ForEach(ble.found, id: \.identifier) { p in
                Button("Connect: \(p.name ?? "glasses")") { ble.connect(p) }.buttonStyle(.bordered)
            }

            TextField("text to show on glasses", text: $text)
                .textFieldStyle(.roundedBorder)

            HStack {
                Button("Open session") { ble.openCaptionSession() }
                Button("Send A (type11)") { ble.sendCaptionStateText(text) }.buttonStyle(.borderedProminent)
                Button("Send B (type5)")  { ble.sendCaptionContent(text) }
            }.disabled(!ble.connected)

            Divider()
            Text("log").font(.caption).foregroundColor(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(ble.log.enumerated()), id: \.offset) { _, l in
                        Text(l).font(.system(size: 10, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }.padding()
    }
}

@main
struct GlassesApp: App {
    var body: some Scene { WindowGroup { ContentView() } }
}
