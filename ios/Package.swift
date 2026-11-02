// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DoopCore",
    /* CryptoKit (AppleSignIn) needs 10.15 when the checks run on macOS */
    platforms: [.macOS(.v10_15), .iOS(.v16)],
    products: [.library(name: "DoopCore", targets: ["DoopCore"])],
    targets: [
        .target(name: "DoopCore", path: "Doop/Core"),
        .executableTarget(name: "DoopCoreChecks", dependencies: ["DoopCore"], path: "Tests")
    ]
)
