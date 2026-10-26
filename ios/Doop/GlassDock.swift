import SwiftUI

/// Native Liquid Glass on iOS 26, with an accessible material fallback on older systems.
struct FloatingGlass: ViewModifier {
    /// False when built with an SDK older than iOS 26, so those builds use the material fallback.
    #if compiler(>=6.2)
    static let liquidGlassAvailable = true
    #else
    static let liquidGlassAvailable = false
    #endif
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(Color(uiColor: .secondarySystemBackground), in: Capsule())
                .overlay(Capsule().strokeBorder(.primary.opacity(0.12)))
        } else if #available(iOS 26.0, *), Self.liquidGlassAvailable {
            #if compiler(>=6.2) // needs the iOS 26 SDK; CI still builds with Xcode 16
            content.glassEffect(.regular.interactive(), in: Capsule())
            #else
            content
            #endif
        } else {
            content.background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(.white.opacity(0.35)))
                .shadow(color: .black.opacity(0.12), radius: 16, y: 6)
        }
    }
}

/// A continuous rounded panel keeps the composer's corners stable as its text grows.
struct ComposerGlass: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)

    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(Color(uiColor: .secondarySystemBackground), in: shape)
                .overlay(shape.strokeBorder(.primary.opacity(0.12)))
        } else if #available(iOS 26.0, *), FloatingGlass.liquidGlassAvailable {
            #if compiler(>=6.2)
            content.glassEffect(.regular, in: shape)
            #else
            content
            #endif
        } else {
            content.background(.regularMaterial, in: shape)
                .overlay(shape.strokeBorder(.primary.opacity(0.12)))
                .shadow(color: .black.opacity(0.10), radius: 18, y: 6)
        }
    }
}

struct GlassDock<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        HStack(spacing: 4) { content }
            .padding(4).modifier(FloatingGlass())
    }
}

struct GlassDockButton: View {
    let label: String
    let symbol: String
    var selected = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 19, weight: .regular))
                .frame(width: 44, height: 44)
                .background(selected ? Color.primary.opacity(0.09) : .clear, in: Capsule())
                .contentShape(Capsule())
        }.buttonStyle(.plain).accessibilityLabel(label).help(label)
            .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}
