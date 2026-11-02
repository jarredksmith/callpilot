// swift-tools-version: 5.9
import PackageDescription

// CallPilot's native plugins. Capacitor's CLI adds this package to CapApp-SPM on `npx cap sync ios`
// (it is the "callpilot-native" dependency in ../package.json, so its product is named CallpilotNative).
let package = Package(
    name: "CallpilotNative",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "CallpilotNative", targets: ["CallpilotNativePlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "CallpilotNativePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/CallpilotNativePlugin")
    ]
)
