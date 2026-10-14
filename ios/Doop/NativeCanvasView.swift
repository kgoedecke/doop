import SwiftUI
import UIKit

struct NativeCanvasView: View {
    @StateObject private var model: CanvasModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var sheet: Panel?
    @State private var prompt = ""
    @State private var sending = false
    @State private var exportURL: URL?
    private let summary: CanvasSummary
    private enum Panel: String, Identifiable { case frames, inspector, tasks, comments, export; var id: String { rawValue } }

    init(summary: CanvasSummary, client: DoopClient) {
        self.summary = summary
        _model = StateObject(wrappedValue: CanvasModel(id: summary.id, client: client))
    }

    var body: some View {
        GeometryReader { geometry in
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                Circle().fill(model.connected ? .green : .orange).frame(width: 6, height: 6)
                Text(model.connected ? "Live" : "Connecting…")
                Spacer()
                if !model.presences.isEmpty { Label("\(model.presences.count) here", systemImage: "person.2") }
                Text("\(model.canvas?.frames.count ?? 0) \(model.canvas?.frames.count == 1 ? "frame" : "frames")")
            }.font(.caption).foregroundStyle(.secondary).padding(.horizontal, 18).padding(.vertical, 10)
            if let error = model.error {
                HStack {
                    Text(error).font(.caption)
                    Spacer()
                    Button { model.error = nil } label: { Image(systemName: "xmark") }.accessibilityLabel("Dismiss message")
                }.padding(12).background(Color.orange.opacity(0.12))
            }
            ZStack(alignment: .bottom) {
                BlitzCanvasSurface(model: model).ignoresSafeArea(.container, edges: .bottom)
                VStack(spacing: 10) {
                    if let element = model.selectedElement {
                        HStack(spacing: 10) {
                            Image(systemName: "scope").foregroundStyle(.tint)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(element.label).font(.callout.monospaced().bold()).lineLimit(1)
                                Text(element.text.isEmpty ? element.selector : element.text).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            Button("Comment") { sheet = .comments }.font(.callout.bold())
                            Button { model.selectedElement = nil } label: { Image(systemName: "xmark") }.accessibilityLabel("Clear element selection")
                        }.padding(.horizontal, 16).padding(.vertical, 12).modifier(FloatingGlass())
                    } else if model.inspecting, model.selected != nil {
                        Text("Tap an element in the selected frame").font(.caption).padding(10).modifier(FloatingGlass())
                    }
                    VStack(spacing: 10) {
                        HStack(spacing: 10) {
                            Image(systemName: "sparkles").foregroundStyle(.tint)
                            TextField("Ask your agent to design…", text: $prompt, axis: .vertical).lineLimit(1...4)
                                .textFieldStyle(.plain)
                                .accessibilityIdentifier("canvas.prompt")
                            Button(action: sendPrompt) {
                                if sending { ProgressView() } else { Image(systemName: "arrow.up.circle.fill").font(.title) }
                            }.disabled(sending || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.connected)
                                .accessibilityLabel("Send design task")
                        }.padding(.horizontal, 16).padding(.vertical, 14).modifier(FloatingGlass())
                        GlassDock {
                            GlassDockButton(label: "Add frame", symbol: "plus", caption: "Add") { Task { await model.addFrame() } }
                            GlassDockButton(label: "Fit canvas", symbol: "arrow.up.left.and.arrow.down.right", caption: "Fit") { model.viewportCommand += 1 }
                            GlassDockButton(label: "Frames", symbol: "square.3.layers.3d") { sheet = .frames }
                            GlassDockButton(label: "Frame properties", symbol: "slider.horizontal.3", caption: "Properties") { sheet = .inspector }.disabled(model.selected == nil)
                            GlassDockButton(label: "Inspect elements", symbol: "scope", caption: "Inspect", selected: model.inspecting) {
                                model.inspecting.toggle()
                                if !model.inspecting { model.selectedElement = nil }
                            }.disabled(model.selected == nil)
                        }
                    }
                }.frame(maxWidth: 620).padding(.horizontal, 16).padding(.top, 10)
                    .offset(y: geometry.safeAreaInsets.bottom < 80 ? max(0, geometry.safeAreaInsets.bottom - 16) : 0)
            }
        }
        .background(CanvasBackSwipeGuard())
        .navigationTitle(model.canvas?.name ?? summary.name).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { sheet = .tasks } label: { Label("Agent tasks", systemImage: "sparkles") }
                    Button { sheet = .comments } label: { Label("Comments", systemImage: "bubble.left.and.bubble.right") }
                    ShareLink(item: model.client.server.origin.appendingPathComponent("c/\(model.id)")) { Label("Share canvas link", systemImage: "square.and.arrow.up") }
                    if model.selected != nil { Button("Export selected frame HTML") { exportFrame() } }
                } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("Canvas actions")
            }
        }
        .sheet(item: $sheet) { panel in
            switch panel {
            case .frames: framesPanel
            case .inspector:
                if let frame = model.selected { FrameInspector(model: model, original: frame) }
            case .tasks: TasksPanel(model: model)
            case .comments: CommentsPanel(model: model)
            case .export:
                NavigationStack {
                    VStack(spacing: 24) {
                        Image(systemName: "doc.text").font(.largeTitle)
                        if let exportURL { ShareLink("Save or share HTML", item: exportURL).buttonStyle(.borderedProminent) }
                    }.navigationTitle("Export frame").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { sheet = nil } } }
                }
            }
        }
        .onAppear { model.start() }
        .onDisappear { model.stop() }
        .onChange(of: scenePhase) { phase in if phase == .active { model.start() } else if phase == .background { model.stop() } }
        .onChange(of: model.deleted) { deleted in if deleted { dismiss() } }
    }
    }

    private func sendPrompt() {
        let value = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        sending = true
        Task {
            do { try await model.queue(value); prompt = ""; sheet = .tasks }
            catch { model.error = error.localizedDescription }
            sending = false
        }
    }
    private var framesPanel: some View {
        NavigationStack {
            List(model.canvas?.frames ?? []) { frame in
                Button {
                    model.select(frame.id)
                    sheet = nil
                } label: {
                    HStack {
                        Image(systemName: "rectangle")
                        VStack(alignment: .leading) { Text(frame.name); Text("\(Int(frame.width)) × \(Int(frame.height))").font(.caption).foregroundStyle(.secondary) }
                        Spacer()
                        if model.selectedID == frame.id { Image(systemName: "checkmark") }
                    }.padding(.vertical, 5)
                }
            }.navigationTitle("Frames")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { sheet = nil } } }
        }
    }
    private func exportFrame() {
        guard let frame = model.selected else { return }
        do {
            let destination = try ExportDirectory().destination(suggestedFilename: frame.name + ".html")
            try Data(frame.html.utf8).write(to: destination, options: .atomic)
            exportURL = destination
            sheet = .export
        } catch { model.error = error.localizedDescription }
    }
}

private struct FrameInspector: View {
    @ObservedObject var model: CanvasModel
    let original: DesignFrame
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var width = 390.0
    @State private var height = 844.0
    @State private var html = ""
    @State private var error: String?
    @State private var saving = false
    @State private var deleting = false
    var body: some View {
        NavigationStack {
            Form {
                Section("Frame") {
                    TextField("Name", text: $name)
                    HStack { Text("Width"); Spacer(); TextField("Width", value: $width, format: .number).keyboardType(.decimalPad).multilineTextAlignment(.trailing) }
                    HStack { Text("Height"); Spacer(); TextField("Height", value: $height, format: .number).keyboardType(.decimalPad).multilineTextAlignment(.trailing) }
                }
                Section("HTML") {
                    TextEditor(text: $html).font(.system(.caption, design: .monospaced)).frame(minHeight: 280)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityLabel("Frame HTML")
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
                Section { Button("Delete frame", role: .destructive) { deleting = true } }
            }
            .navigationTitle("Frame properties").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button(saving ? "Saving…" : "Save", action: save).disabled(saving) }
            }
            .onAppear { name = original.name; width = original.width; height = original.height; html = original.html }
            .confirmationDialog("Delete this frame?", isPresented: $deleting, titleVisibility: .visible) {
                Button("Delete", role: .destructive) { Task { do { try await model.deleteFrame(original.id); dismiss() } catch { self.error = error.localizedDescription } } }
            }
        }
    }
    private func save() {
        guard width.isFinite, height.isFinite, (1...10000).contains(width), (1...10000).contains(height), !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            error = "Enter a name and dimensions between 1 and 10,000."; return
        }
        guard let current = model.canvas?.frames.first(where: { $0.id == original.id }) else { error = "This frame was deleted."; return }
        var patch: [String: Any] = [:]
        if name != original.name { patch["name"] = name }
        if width != original.width { patch["width"] = width }
        if height != original.height { patch["height"] = height }
        if html != original.html {
            guard current.html == original.html else { error = "This frame was edited by a collaborator. Close and reopen properties before changing its HTML."; return }
            patch["html"] = html
        }
        saving = true
        Task { do { if !patch.isEmpty { try await model.patchFrame(original.id, patch: patch) }; dismiss() } catch { self.error = error.localizedDescription }; saving = false }
    }
}

private struct TasksPanel: View {
    @ObservedObject var model: CanvasModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                if model.tasks.isEmpty { Text("Ask your agent to design something. Tasks appear here as the team works.").foregroundStyle(.secondary) }
                ForEach(model.tasks.sorted { $0.startedAt > $1.startedAt }) { task in
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: task.failedAt != nil ? "exclamationmark.circle" : task.endedAt != nil ? "checkmark.circle" : "sparkles").foregroundStyle(task.failedAt != nil ? .orange : .blue)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(task.status).font(.body)
                            Text(task.agentName.isEmpty ? "Waiting for an agent" : task.agentName).font(.caption).foregroundStyle(.secondary)
                            if let reason = task.failureReason { Text(reason).font(.caption).foregroundStyle(.orange) }
                        }
                    }.padding(.vertical, 8)
                }
            }.navigationTitle("Agent tasks").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

private struct CommentsPanel: View {
    @ObservedObject var model: CanvasModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var sending = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            List {
                Section(model.selectedElement.map { "Comment on \($0.label)" } ?? "Add a frame comment") {
                    if let element = model.selectedElement, !element.text.isEmpty {
                        Text(element.text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    Picker("Frame", selection: $model.selectedID) {
                        Text("Choose a frame").tag(String?.none)
                        ForEach(model.canvas?.frames ?? []) { Text($0.name).tag(Optional($0.id)) }
                    }
                    TextField("Leave feedback…", text: $text, axis: .vertical).lineLimit(2...5)
                    Button("Post comment") {
                        guard let id = model.selectedID else { return }
                        sending = true
                        Task { do { try await model.comment(text, frameID: id); text = "" } catch { self.error = error.localizedDescription }; sending = false }
                    }.disabled(sending || model.selectedID == nil || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if let error { Text(error).foregroundStyle(.red) }
                }
                Section("Conversation") {
                    if model.comments.isEmpty { Text("No comments yet.").foregroundStyle(.secondary) }
                    ForEach(model.comments.sorted { $0.at > $1.at }) { comment in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack { Text(comment.from).font(.subheadline.bold()); Spacer(); if comment.resolvedAt != nil { Image(systemName: "checkmark.circle").foregroundStyle(.green) } }
                            Text(comment.text)
                            Text(model.canvas?.frames.first(where: { $0.id == comment.frameId })?.name ?? "Frame").font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 6)
                    }
                }
            }.navigationTitle("Comments").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}


/// Canvas panning must not trigger UINavigationController's edge-swipe navigation.
private struct CanvasBackSwipeGuard: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Controller { Controller() }
    func updateUIViewController(_ controller: Controller, context: Context) {}
    static func dismantleUIViewController(_ controller: Controller, coordinator: ()) {
        controller.restoreGesture()
    }

    final class Controller: UIViewController {
        private var gestures: [(UIGestureRecognizer, Bool)] = []

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard let navigationController, gestures.isEmpty else { return }
            var backGestures = [navigationController.interactivePopGestureRecognizer].compactMap { $0 }
            #if compiler(>=6.2) // iOS 26 SDK; CI still builds with Xcode 16
            if #available(iOS 26.0, *), let contentSwipe = navigationController.interactiveContentPopGestureRecognizer {
                backGestures.append(contentSwipe)
            }
            #endif
            gestures = backGestures.map { ($0, $0.isEnabled) }
            for (gesture, _) in gestures { gesture.isEnabled = false }
        }

        override func viewWillDisappear(_ animated: Bool) {
            restoreGesture()
            super.viewWillDisappear(animated)
        }

        func restoreGesture() {
            for (gesture, enabled) in gestures { gesture.isEnabled = enabled }
            gestures.removeAll()
        }
    }
}
