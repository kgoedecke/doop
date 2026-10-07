import CoreGraphics
import Foundation

/// One frame's HTML document inside the Blitz engine (ios/BlitzKit).
///
/// Every method must run on `BlitzDocument.queue`; the engine is driven from
/// one serial queue so documents never race. Rendered bitmaps come back as
/// `CGImage`s that own their pixel buffer.
final class BlitzDocument: @unchecked Sendable {
    /// The single queue every engine call runs on.
    static let queue = DispatchQueue(label: "design.doop.blitz", qos: .userInitiated)

    struct ElementInfo: Decodable {
        var id: UInt64
        var tag: String
        var idAttr: String?
        var classes: [String]
        var selector: String
        var text: String
        var parent: UInt64
        var rect: [Double]?

        var frameRect: CGRect? {
            guard let rect, rect.count == 4 else { return nil }
            return CGRect(x: rect[0], y: rect[1], width: rect[2], height: rect[3])
        }
        /// `tag#id.class.class`, the way inspectors label a node.
        var label: String {
            var value = tag
            if let idAttr, !idAttr.isEmpty { value += "#" + idAttr }
            value += classes.prefix(3).map { "." + $0 }.joined()
            return value
        }
    }

    private var handle: OpaquePointer
    private(set) var id: Int
    private(set) var width: UInt32
    private(set) var height: UInt32
    private(set) var scale: Float

    /// Fired on the main thread when a pending font or image for a document has
    /// arrived and it should be painted again. The engine calls back on its own
    /// thread; the installed trampoline never reads shared state there, it only
    /// hops to the main queue, where this closure is read and written.
    @MainActor static var onWake: ((Int) -> Void)?
    private static let installWake: Void = {
        doopblitz_set_wake_callback { docID in
            DispatchQueue.main.async { BlitzDocument.onWake?(docID) }
        }
    }()

    init(html: String, baseURL: URL, width: Double, height: Double, scale: Float) {
        _ = BlitzDocument.installWake
        self.width = UInt32(max(1, width.rounded()))
        self.height = UInt32(max(1, height.rounded()))
        self.scale = scale
        handle = doopblitz_doc_new(html, baseURL.absoluteString, self.width, self.height, scale)
        id = doopblitz_doc_id(handle)
    }

    deinit { doopblitz_doc_free(handle) }

    /// True while fonts or images are still being fetched.
    var isLoading: Bool { doopblitz_doc_loading(handle) }

    func setHTML(_ html: String) {
        doopblitz_doc_set_html(handle, html)
        id = doopblitz_doc_id(handle)
    }

    func setViewport(width: Double, height: Double, scale: Float) {
        self.width = UInt32(max(1, width.rounded()))
        self.height = UInt32(max(1, height.rounded()))
        self.scale = scale
        doopblitz_doc_set_viewport(handle, self.width, self.height, scale)
    }

    /// True when the document has running CSS animations or transitions.
    var isAnimating: Bool { doopblitz_doc_is_animating(handle) }

    /// Resolve layout and paint the frame at `width × scale` physical pixels,
    /// with CSS animations advanced to `time` seconds.
    func render(time: Double = 0) -> CGImage? {
        var w: UInt32 = 0, h: UInt32 = 0, len = 0
        guard let pixels = doopblitz_doc_render_at(handle, time, &w, &h, &len), w > 0, h > 0 else { return nil }
        return Self.image(from: pixels, width: w, height: h, length: len)
    }

    /// Wrap an engine-owned RGBA buffer in a CGImage that frees it when released.
    private static func image(from pixels: UnsafeMutablePointer<UInt8>, width w: UInt32, height h: UInt32, length len: Int) -> CGImage? {
        let provider = CGDataProvider(dataInfo: UnsafeMutableRawPointer(bitPattern: len), data: pixels, size: len) { info, data, _ in
            doopblitz_buffer_free(UnsafeMutablePointer(mutating: data.assumingMemoryBound(to: UInt8.self)), Int(bitPattern: info))
        }
        guard let provider else { doopblitz_buffer_free(pixels, len); return nil }
        return CGImage(width: Int(w), height: Int(h), bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: Int(w) * 4,
                       space: CGColorSpaceCreateDeviceRGB(),
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }

    /// Paint only `region` (CSS pixels of the frame) at `density` bitmap pixels per
    /// CSS pixel: a tile for deep zoom. Leaves the document at that density.
    func render(region: CGRect, density: CGFloat, time: Double = 0) -> CGImage? {
        var w: UInt32 = 0, h: UInt32 = 0, len = 0
        guard let pixels = doopblitz_doc_render_region_at(handle, time, Float(density), Float(region.minX), Float(region.minY), Float(region.width), Float(region.height), &w, &h, &len), w > 0, h > 0 else { return nil }
        scale = Float(density)
        return Self.image(from: pixels, width: w, height: h, length: len)
    }

    /// The element under a point in the frame's CSS pixels, or nil.
    func element(at point: CGPoint) -> UInt64? {
        let node = doopblitz_doc_element_from_point(handle, Float(point.x), Float(point.y))
        return node == 0 ? nil : node
    }

    func element(matching selector: String) -> UInt64? {
        let node = doopblitz_doc_query_selector(handle, selector)
        return node == 0 ? nil : node
    }

    func parent(of node: UInt64) -> UInt64? {
        let parent = doopblitz_node_parent(handle, node)
        return parent == 0 ? nil : parent
    }

    func info(for node: UInt64) -> ElementInfo? {
        guard let raw = doopblitz_node_info(handle, node) else { return nil }
        defer { doopblitz_string_free(raw) }
        return try? JSONDecoder().decode(ElementInfo.self, from: Data(String(cString: raw).utf8))
    }
}
