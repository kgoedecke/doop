import SwiftUI

/// Native Liquid Glass on iOS 26, with an accessible material fallback on older systems.
struct FloatingGlass: ViewModifier {
    /// False when built with an SDK older than iOS 26, so those builds use the material fallback.
    #if compiler(>=6.2)
    static let liquidGlassAvailable = true
    #else
    static let liquidGlassAvailable = false
    #endif
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(Color(uiColor: .secondarySystemBackground), in: Capsule())
                .overlay(Capsule().strokeBorder(.primary.opacity(0.12)))
        } else if #available(iOS 26.0, *), Self.liquidGlassAvailable {
            #if compiler(>=6.2) // needs the iOS 26 SDK; CI still builds with Xcode 16
            content.glassEffect(.regular.tint(colorScheme == .dark ? Color.black.opacity(0.45) : .clear).interactive(), in: Capsule())
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

struct GlassDock<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        HStack(spacing: 4) { content }
            .padding(6).modifier(FloatingGlass())
    }
}

struct GlassDockButton: View {
    let label: String
    let symbol: String
    var caption: String? = nil
    var selected = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: symbol).font(.system(size: 22, weight: .medium))
                    .frame(height: 24)
                Text(caption ?? label).font(.caption2.weight(.medium))
                    .lineLimit(1).minimumScaleFactor(0.8)
            }
                .padding(.horizontal, 2).padding(.vertical, 5)
                .frame(maxWidth: .infinity).frame(minHeight: 56)
                .background(selected ? Color.primary.opacity(0.09) : .clear, in: Capsule())
                .contentShape(Capsule())
        }.buttonStyle(.plain).accessibilityLabel(label)
            .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}
