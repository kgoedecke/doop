import SwiftUI
import UIKit

struct NativeCanvasView: View {
    @StateObject private var model: CanvasModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var sheet: Panel?
    @State private var prompt = ""
    @State private var sending = false
    /// The scope key the person dismissed with the chip's ×; a new selection brings the chip back.
    @State private var dismissedScope: String?
    @State private var actionBusy = false
    @State private var clipboardAvailable = CanvasClipboard.isAvailable
    @State private var copiedSelection = false
    private let summary: CanvasSummary
    private enum Panel: Identifiable {
        case frames, inspector, tasks, comments
        case export(CanvasSelection)
        var id: String {
            switch self {
            case .frames: return "frames"
            case .inspector: return "inspector"
            case .tasks: return "tasks"
            case .comments: return "comments"
            case .export: return "export"
            }
        }
    }

    init(summary: CanvasSummary, client: DoopClient) {
        self.summary = summary
        _model = StateObject(wrappedValue: CanvasModel(id: summary.id, client: client))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                Menu {
                    Picker("Page", selection: Binding(get: { model.activePageID }, set: { model.selectPage($0) })) {
                        ForEach(model.pages) { page in Text(page.name).tag(page.id) }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text(model.activePage.name).lineLimit(1)
                        Image(systemName: "chevron.down").font(.caption2)
                    }.foregroundStyle(.primary).frame(minHeight: 44)
                }
                .disabled(model.canvas == nil)
                .accessibilityLabel("Page").accessibilityValue(model.activePage.name)
                .accessibilityIdentifier("canvas.pagePicker")
                Spacer()
                Circle().fill(model.connected ? .green : .orange).frame(width: 6, height: 6)
                    .accessibilityLabel(model.connected ? "Live" : model.connecting ? "Connecting" : "Disconnected")
                if !model.pagePresences.isEmpty { Label("\(model.pagePresences.count) here", systemImage: "person.2") }
                Text("\(model.pageFrames.count) \(model.pageFrames.count == 1 ? "frame" : "frames")")
                    .accessibilityIdentifier("canvas.frameCount")
            }.font(.caption).foregroundStyle(.secondary).padding(.horizontal, 18)
            if let error = model.error ?? model.connectionError {
                HStack {
                    Text(error).font(.caption)
                    Spacer()
                    Button { if model.error != nil { model.error = nil } else { model.connectionError = nil } } label: { Image(systemName: "xmark") }.accessibilityLabel("Dismiss message")
                }.padding(12).background(Color.orange.opacity(0.12))
            }
            ZStack(alignment: .bottom) {
                VStack(spacing: 10) {
                    if model.selected != nil || clipboardAvailable {
                        selectionActions
                    }
                    HStack(spacing: 10) {
                        if let scope = promptScope {
                            PromptScopeChip(scope: scope) { dismissedScope = scope.key }
                        } else {
                            Image(systemName: "sparkles").foregroundStyle(.tint)
                        }
                        TextField(promptPlaceholder, text: $prompt, axis: .vertical).lineLimit(1...4)
                            .textFieldStyle(.plain)
                            .accessibilityIdentifier("canvas.prompt")
                        Button(action: sendPrompt) {
                            if sending { ProgressView() } else { Image(systemName: "arrow.up.circle.fill").font(.title) }
                        }.disabled(sending || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.connected)
                            .accessibilityLabel("Send design task")
                    }.padding(.horizontal, 16).padding(.vertical, 14).modifier(FloatingGlass())
                }.frame(maxWidth: 620).padding(12)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .background {
                // The renderer fills the home-indicator area; controls retain
                // the safe area. CanvasView clips its layers below the header.
                BlitzCanvasSurface(model: model)
                    .ignoresSafeArea(.container, edges: .bottom)
            }
            .overlay(alignment: .topTrailing) { canvasTools.padding(12) }
        }
        .background(CanvasBackSwipeGuard())
        .navigationTitle(model.canvas?.name ?? summary.name).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button { sheet = .tasks } label: { Label("Agent tasks", systemImage: "sparkles") }
                    Button { sheet = .comments } label: { Label("Comments", systemImage: "bubble.left.and.bubble.right") }
                    ShareLink(item: model.client.server.origin.appendingPathComponent("c/\(model.id)")) { Label("Share canvas link", systemImage: "square.and.arrow.up") }
                    if model.selected != nil { Button("Export selection") { openExport() } }
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
            case .export(let selection):
                SelectionExportPanel(selection: selection, origin: model.client.server.origin)
            }
        }
        .onAppear { clipboardAvailable = CanvasClipboard.isAvailable; if scenePhase == .active { model.start() } }
        .onDisappear { model.stop() }
        .onChange(of: scenePhase) { phase in if phase == .active { clipboardAvailable = CanvasClipboard.isAvailable; model.start() } else if phase == .background { model.stop() } }
        .onReceive(NotificationCenter.default.publisher(for: UIPasteboard.changedNotification)) { _ in
            clipboardAvailable = CanvasClipboard.isAvailable
            copiedSelection = false
        }
        .onChange(of: model.promptScope?.key) { _ in copiedSelection = false }
        .onChange(of: model.deleted) { deleted in if deleted { dismiss() } }
        .onChange(of: model.activePageID) { _ in
            dismissedScope = nil
            if sheet?.id == "inspector" || sheet?.id == "export" { sheet = nil }
        }
    }

    private var canvasTools: some View {
        VStack(spacing: 2) {
            GlassDockButton(label: "Undo", symbol: "arrow.uturn.backward") { Task { await model.undo() } }
                .disabled(!model.canUndo).accessibilityIdentifier("canvas.undo")
                .keyboardShortcut("z", modifiers: .command)
            Divider().frame(width: 24).padding(.vertical, 2)
            GlassDockButton(label: "Add frame", symbol: "plus") { Task { await model.addFrame() } }
                .disabled(!model.canEdit)
            GlassDockButton(label: "Fit canvas", symbol: "arrow.up.left.and.arrow.down.right") { model.viewportCommand += 1 }
            GlassDockButton(label: "Frames", symbol: "square.3.layers.3d") { sheet = .frames }
            GlassDockButton(label: "Frame properties", symbol: "slider.horizontal.3") { sheet = .inspector }
                .disabled(model.selected == nil || !model.canEdit)
        }.padding(4).modifier(FloatingGlass())
    }

    /// The selection scopes the prompt, as on the web, until the chip is dismissed.
    private var promptScope: PromptScope? {
        guard let scope = model.promptScope, scope.key != dismissedScope else { return nil }
        return scope
    }

    private var promptPlaceholder: String {
        guard let scope = promptScope else { return "Ask your agent to design…" }
        return scope.isElement ? "Ask your agent to change this element…" : "Ask your agent to change this frame…"
    }

    private func sendPrompt() {
        let value = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        sending = true
        let scope = promptScope?.scope
        Task {
            do { try await model.queue(value, scope: scope); prompt = ""; sheet = .tasks }
            catch { model.error = error.localizedDescription }
            sending = false
        }
    }
    private var framesPanel: some View {
        NavigationStack {
            List {
                if model.pageFrames.isEmpty { Text("No frames on this page.").foregroundStyle(.secondary) }
                ForEach(model.pageFrames) { frame in
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
                }
            }.navigationTitle(model.activePage.name)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { sheet = nil } } }
        }
    }
    private var selectionActions: some View {
        actionButtons
        .fixedSize(horizontal: false, vertical: true)
        .modifier(FloatingGlass())
        .frame(maxWidth: 360)
        .padding(.horizontal, 12)
        .disabled(actionBusy)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Selection actions")
        .accessibilityIdentifier("canvas.selectionActions")
    }

    private var actionButtons: some View {
        HStack(spacing: 0) {
            selectionAction(copiedSelection ? "Copied" : "Copy", symbol: copiedSelection ? "checkmark" : "doc.on.doc", id: "copy", disabled: model.selection == nil) {
                guard let selection = model.selection else { return }
                runSelectionAction { try await model.copySelection(selection); clipboardAvailable = true; copiedSelection = true }
            }
            selectionAction("Paste", symbol: "doc.on.clipboard", id: "paste", disabled: !clipboardAvailable || !model.canEdit) {
                let selection = model.selection
                runSelectionAction { try await model.pasteSelection(selection) }
            }
            selectionAction("Duplicate", symbol: "plus.square.on.square", id: "duplicate", disabled: !canEditSelection) {
                guard let selection = model.selection else { return }
                runSelectionAction { try await model.duplicateSelection(selection) }
            }
            selectionAction("Delete", symbol: "trash", id: "delete", disabled: !canEditSelection) {
                guard let selection = model.selection else { return }
                runSelectionAction { try await model.deleteSelection(selection) }
            }
            selectionAction("Comment", symbol: "bubble.left", id: "comment", disabled: model.selection == nil) { sheet = .comments }
            selectionAction("Export", symbol: "square.and.arrow.up", id: "export", disabled: model.selection == nil) { openExport() }
        }.padding(.horizontal, 4).padding(.vertical, 5)
    }

    private var canEditSelection: Bool { model.canEdit && model.selected != nil && model.selected?.locked != true }

    private func selectionAction(_ title: String, symbol: String, id: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 19))
            .frame(minWidth: 44, maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityLabel(title)
        .accessibilityIdentifier("canvas." + id)
        .help(title)
    }

    private func runSelectionAction(_ action: @escaping () async throws -> Void) {
        actionBusy = true
        Task {
            do { try await action() } catch { model.error = error.localizedDescription }
            actionBusy = false
        }
    }

    private func openExport() {
        if let selection = model.selection { sheet = .export(selection) }
    }
}

/// The prompt bar's scope: the selected frame's name, or the picked element's
/// `tag#id.class`, with an × that asks without it.
private struct PromptScopeChip: View {
    let scope: PromptScope
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: scope.isElement ? "scope" : "rectangle").font(.caption)
            Text(scope.label).font(.caption.monospaced().bold()).lineLimit(1).truncationMode(.tail)
            Button(action: dismiss) { Image(systemName: "xmark").font(.caption2.bold()) }
                .accessibilityLabel(scope.isElement ? "Remove element scope" : "Remove frame scope")
        }
        .foregroundStyle(.tint)
        .padding(.leading, 8).padding(.trailing, 6).padding(.vertical, 5)
        .background(Color.primary.opacity(0.09), in: Capsule())
        .frame(maxWidth: 150, alignment: .leading)
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(scope.isElement ? "Scoped to \(scope.label) in \(scope.frameName)" : "Scoped to the frame \(scope.label)")
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
                        Image(systemName: task.failedAt != nil ? "exclamationmark.circle" : task.endedAt != nil ? "checkmark.circle" : "sparkles").foregroundStyle(task.failedAt != nil ? .orange : .primary)
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
                    Picker("Frame", selection: Binding(get: { model.selectedID }, set: { model.select($0) })) {
                        Text("Choose a frame").tag(String?.none)
                        ForEach(model.pageFrames) { Text($0.name).tag(Optional($0.id)) }
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
                    if model.pageComments.isEmpty { Text("No comments on this page yet.").foregroundStyle(.secondary) }
                    ForEach(model.pageComments.sorted { $0.at > $1.at }) { comment in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack { Text(comment.from).font(.subheadline.bold()); Spacer(); if comment.resolvedAt != nil { Image(systemName: "checkmark.circle").foregroundStyle(.green) } }
                            Text(comment.text)
                            Text(model.canvas?.frames.first(where: { $0.id == comment.frameId })?.name ?? (comment.frameId == nil ? "Canvas" : "Deleted frame")).font(.caption).foregroundStyle(.secondary)
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
