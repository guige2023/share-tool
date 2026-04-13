// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ShareTool",
    platforms: [.macOS("13.0")],
    products: [
        .executable(
            name: "ShareTool",
            targets: ["ShareTool"]
        )
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "ShareTool",
            dependencies: [],
            path: "ShareTool"
        )
    ]
)
