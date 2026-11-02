import Foundation
import UIKit
import UserNotifications
import Capacitor

/// Native notifications for CallPilot notes. They show whether CallPilot is open, in the background, or the
/// phone is locked, and they're what the glasses mirror. Compared with web notifications this adds:
/// time-sensitive delivery (gets through Focus modes), banners while the app is open, notes that clear
/// themselves after a while, and lock-screen buttons (Note now, Bookmark, Replay).
///
/// Events: "action" {action: open|note|bookmark|replay|dismiss, id}
@objc(CPNotifyPlugin)
public class CPNotifyPlugin: CAPPlugin, CAPBridgedPlugin, NotificationHandlerProtocol {
    public let identifier = "CPNotifyPlugin"
    public let jsName = "CPNotify"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "allow", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "post", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setForeground", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise)
    ]

    private var showBannerInApp = true

    override public func load() {
        bridge?.notificationRouter.localNotificationHandler = self
        let note = UNNotificationAction(identifier: "note", title: "Note now", options: [])
        let bookmark = UNNotificationAction(identifier: "bookmark", title: "Bookmark", options: [])
        let replay = UNNotificationAction(identifier: "replay", title: "Replay", options: [])
        let noteCategory = UNNotificationCategory(identifier: "cp-note", actions: [note, bookmark, replay], intentIdentifiers: [], options: [.customDismissAction])
        let plainCategory = UNNotificationCategory(identifier: "cp-plain", actions: [], intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([noteCategory, plainCategory])
    }

    // MARK: - JS methods

    @objc func status(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            call.resolve(CPNotifyPlugin.describe(settings))
        }
    }

    @objc func allow(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                call.resolve(CPNotifyPlugin.describe(settings))
            }
        }
    }

    /// Shows a notification right now.
    /// Options: title, body, id, sound (bool), level ("timeSensitive" | "active" | "passive"),
    ///          clearAfter (seconds, 0 = keep), thread, actions (bool: show Note now / Bookmark / Replay)
    @objc func post(_ call: CAPPluginCall) {
        let content = UNMutableNotificationContent()
        content.title = call.getString("title") ?? ""
        content.body = call.getString("body") ?? ""
        if call.getBool("sound") ?? false { content.sound = .default }
        content.threadIdentifier = call.getString("thread") ?? "callpilot"
        content.categoryIdentifier = (call.getBool("actions") ?? true) ? "cp-note" : "cp-plain"
        if #available(iOS 15.0, *) {
            switch call.getString("level") ?? "timeSensitive" {
            case "passive": content.interruptionLevel = .passive
            case "active": content.interruptionLevel = .active
            default: content.interruptionLevel = .timeSensitive
            }
            content.relevanceScore = 1
        }
        let id = call.getString("id") ?? UUID().uuidString
        let clearAfter = call.getDouble("clearAfter") ?? 0
        let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                call.reject("Couldn't show the notification: \(error.localizedDescription)")
                return
            }
            if clearAfter > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + clearAfter) {
                    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [id])
                }
            }
            call.resolve(["id": id])
        }
    }

    /// Removes delivered notes: the ones listed in `ids`, or all of CallPilot's when none are given.
    @objc func clear(_ call: CAPPluginCall) {
        let center = UNUserNotificationCenter.current()
        if let ids = call.getArray("ids") as? [String], !ids.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: ids)
        } else {
            center.removeAllDeliveredNotifications()
        }
        call.resolve()
    }

    /// Whether a note also pops up as a banner while CallPilot is open on screen.
    @objc func setForeground(_ call: CAPPluginCall) {
        showBannerInApp = call.getBool("banner") ?? true
        call.resolve()
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var link = UIApplication.openSettingsURLString
            if #available(iOS 16.0, *) { link = UIApplication.openNotificationSettingsURLString }
            if let url = URL(string: link) { UIApplication.shared.open(url) }
            call.resolve()
        }
    }

    // MARK: - Presenting and tapping

    public func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        // While CallPilot is open, still put the note in Notification Center (that's what the glasses
        // mirror), and show the banner unless that's been turned off.
        var options: UNNotificationPresentationOptions = [.list]
        if showBannerInApp { options.insert(.banner) }
        if notification.request.content.sound != nil { options.insert(.sound) }
        return options
    }

    public func didReceive(response: UNNotificationResponse) {
        let action: String
        switch response.actionIdentifier {
        case UNNotificationDefaultActionIdentifier: action = "open"
        case UNNotificationDismissActionIdentifier: action = "dismiss"
        default: action = response.actionIdentifier
        }
        notifyListeners("action", data: ["action": action, "id": response.notification.request.identifier], retainUntilConsumed: true)
    }

    // MARK: - Helpers

    private static func describe(_ s: UNNotificationSettings) -> [String: Any] {
        let status: String
        switch s.authorizationStatus {
        case .authorized, .ephemeral: status = "granted"
        case .provisional: status = "provisional"
        case .denied: status = "denied"
        case .notDetermined: status = "prompt"
        @unknown default: status = "prompt"
        }
        var timeSensitive = "unsupported"
        if #available(iOS 15.0, *) {
            switch s.timeSensitiveSetting {
            case .enabled: timeSensitive = "on"
            case .disabled: timeSensitive = "off"
            default: timeSensitive = "unsupported"
            }
        }
        return [
            "status": status,
            "timeSensitive": timeSensitive,
            "lockScreen": s.lockScreenSetting == .enabled,
            "banners": s.alertSetting == .enabled,
            "sounds": s.soundSetting == .enabled
        ]
    }
}
