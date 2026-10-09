import CoreGraphics
import UIKit

/// Brand marks for well-known agents, mirroring the web app's `AgentIcon`:
/// Claude and OpenAI (Codex) from Simple Icons (CC0), the Doop mark otherwise.
enum AgentMark {
    private static let claude =
        "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
    private static let openai =
        "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
    private static var cache: [String: CGPath] = [:]

    /// The mark for an agent name: brand icons for Claude and Codex/GPT, the
    /// Doop mark for the built-in roles and unknown MCP clients.
    static func path(for name: String) -> CGPath {
        let key = brand(for: name)
        if let cached = cache[key] { return cached }
        let path: CGPath
        switch key {
        case "claude": path = SVGPath.parse(claude)
        case "openai": path = SVGPath.parse(openai)
        default: path = doopMark()
        }
        cache[key] = path
        return path
    }

    /// Which mark an agent name gets: "claude", "openai", or "doop".
    static func brand(for name: String) -> String {
        let n = name.lowercased()
        return n.contains("claude") ? "claude" : (n.contains("codex") || n.contains("gpt")) ? "openai" : "doop"
    }

    /// The Doop mark: a half disc with a dot at its foot (viewBox 42 32 118 137, translated by 14).
    static func doopMark() -> CGPath {
        let p = CGMutablePath()
        p.move(to: CGPoint(x: 92, y: 36))
        p.addArc(center: CGPoint(x: 92, y: 100), radius: 64, startAngle: -.pi / 2, endAngle: .pi / 2, clockwise: false)
        p.closeSubpath()
        p.addEllipse(in: CGRect(x: 64 - 19, y: 146 - 19, width: 38, height: 38))
        return p
    }
}

/// A small SVG path-data parser: M L H V C S Q T A Z and their relative forms,
/// enough for Simple Icons glyphs.
enum SVGPath {
    static func parse(_ d: String) -> CGPath {
        let path = CGMutablePath()
        var tokens = tokenize(d)
        var index = 0
        var command: Character = "M"
        var current = CGPoint.zero, start = CGPoint.zero, lastControl: CGPoint?
        func number() -> CGFloat { defer { index += 1 }; return index < tokens.count ? tokens[index].number ?? 0 : 0 }
        func point(_ relative: Bool) -> CGPoint {
            let p = CGPoint(x: number(), y: number())
            return relative ? CGPoint(x: current.x + p.x, y: current.y + p.y) : p
        }
        while index < tokens.count {
            if let c = tokens[index].command { command = c; index += 1 }
            let relative = command.isLowercase
            switch command.uppercased() {
            case "M":
                current = point(relative); start = current; path.move(to: current); lastControl = nil
                command = relative ? "l" : "L"
            case "L":
                current = point(relative); path.addLine(to: current); lastControl = nil
            case "H":
                let x = number(); current.x = relative ? current.x + x : x; path.addLine(to: current); lastControl = nil
            case "V":
                let y = number(); current.y = relative ? current.y + y : y; path.addLine(to: current); lastControl = nil
            case "C":
                let c1 = point(relative), c2 = point(relative), end = point(relative)
                path.addCurve(to: end, control1: c1, control2: c2); lastControl = c2; current = end
            case "S":
                let c1 = lastControl.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let c2 = point(relative), end = point(relative)
                path.addCurve(to: end, control1: c1, control2: c2); lastControl = c2; current = end
            case "Q":
                let c = point(relative), end = point(relative)
                path.addQuadCurve(to: end, control: c); lastControl = c; current = end
            case "T":
                let c = lastControl.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let end = point(relative)
                path.addQuadCurve(to: end, control: c); lastControl = c; current = end
            case "A":
                let rx = number(), ry = number(), rotation = number(), large = number() != 0, sweep = number() != 0
                let end = point(relative)
                arc(path, from: current, to: end, rx: rx, ry: ry, rotation: rotation, large: large, sweep: sweep)
                current = end; lastControl = nil
            case "Z":
                path.closeSubpath(); current = start; lastControl = nil
                if index < tokens.count, tokens[index].command == nil { command = "L" }
            default:
                index += 1
            }
        }
        tokens.removeAll()
        return path
    }

    private struct Token { var command: Character?; var number: CGFloat? }

    private static func tokenize(_ d: String) -> [Token] {
        var tokens: [Token] = []
        var buffer = ""
        func flush() { if let v = Double(buffer) { tokens.append(Token(command: nil, number: CGFloat(v))) }; buffer = "" }
        for ch in d {
            if ch.isLetter, ch != "e", ch != "E" {
                flush(); tokens.append(Token(command: ch, number: nil))
            } else if ch == "," || ch == " " || ch == "\n" || ch == "\t" {
                flush()
            } else if ch == "-", !buffer.isEmpty, !buffer.hasSuffix("e"), !buffer.hasSuffix("E") {
                flush(); buffer = "-"
            } else if ch == ".", buffer.contains("."), !buffer.contains("e"), !buffer.contains("E") {
                flush(); buffer = "."
            } else {
                buffer.append(ch)
            }
        }
        flush()
        return tokens
    }

    /// SVG elliptical arc, converted to cubic segments (endpoint to centre form).
    private static func arc(_ path: CGMutablePath, from p0: CGPoint, to p1: CGPoint, rx: CGFloat, ry: CGFloat, rotation: CGFloat, large: Bool, sweep: Bool) {
        guard rx > 0, ry > 0, p0 != p1 else { path.addLine(to: p1); return }
        let phi = rotation * .pi / 180, cosPhi = cos(phi), sinPhi = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1 = cosPhi * dx + sinPhi * dy, y1 = -sinPhi * dx + cosPhi * dy
        var rx = rx, ry = ry
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 { rx *= lambda.squareRoot(); ry *= lambda.squareRoot() }
        let num = max(0, rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1)
        let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
        var coef = den == 0 ? 0 : (num / den).squareRoot()
        if large == sweep { coef = -coef }
        let cx1 = coef * rx * y1 / ry, cy1 = -coef * ry * x1 / rx
        let cx = cosPhi * cx1 - sinPhi * cy1 + (p0.x + p1.x) / 2
        let cy = sinPhi * cx1 + cosPhi * cy1 + (p0.y + p1.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy, len = (ux * ux + uy * uy).squareRoot() * (vx * vx + vy * vy).squareRoot()
            var a = acos(max(-1, min(1, dot / len)))
            if ux * vy - uy * vx < 0 { a = -a }
            return a
        }
        let theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep, delta > 0 { delta -= 2 * .pi } else if sweep, delta < 0 { delta += 2 * .pi }
        let segments = Int(ceil(abs(delta) / (.pi / 2)))
        let step = delta / CGFloat(segments)
        var a = theta
        for _ in 0..<segments {
            let t = 4 / 3 * tan(step / 4)
            let (c1, s1, c2, s2) = (cos(a), sin(a), cos(a + step), sin(a + step))
            func map(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(x: cosPhi * rx * x - sinPhi * ry * y + cx, y: sinPhi * rx * x + cosPhi * ry * y + cy)
            }
            let q1 = map(c1 - t * s1, s1 + t * c1), q2 = map(c2 + t * s2, s2 - t * c2), end = map(c2, s2)
            path.addCurve(to: end, control1: q1, control2: q2)
            a += step
        }
    }
}
