// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DoopCore",
    products: [.library(name: "DoopCore", targets: ["DoopCore"])],
    targets: [
        .target(name: "DoopCore", path: "Doop/Core"),
        .executableTarget(name: "DoopCoreChecks", dependencies: ["DoopCore"], path: "Tests")
    ]
)
