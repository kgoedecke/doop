import SwiftUI
import UIKit

struct NativeCanvasView: View {
    @StateObject private var model: CanvasModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var sheet: Panel?
    @State private var prompt = ""
    @State private var agentAssignment = AgentAssignment.automatic
    @State private var modelAccount: AgentModelAccount?
    @State private var modelPickerOpen = false
    @State private var loadingModels = false
    @State private var changingModel = false
    @State private var modelError: String?
    @State private var contextReferences: [PromptContextReference] = []
    @State private var contextPickerOpen = false
    @State private var dismissedMention: String?
    @FocusState private var promptFocused: Bool
    @State private var sending = false
    /// The scope key the person dismissed with the chip's ×; a new selection brings the chip back.
    @State private var dismissedScope: String?
    @State private var actionBusy = false
    @State private var clipboardAvailable = CanvasClipboard.isAvailable
    @State private var copiedSelection = false
    private let summary: CanvasSummary
    private let currentUser: DoopUser?
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

    init(summary: CanvasSummary, client: DoopClient, currentUser: DoopUser? = nil) {
        self.currentUser = currentUser
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
                    if modelPickerOpen {
                        modelPicker
                    } else if showContextPicker {
                        contextPicker
                    } else if model.selected != nil || clipboardAvailable {
                        selectionActions
                    }
                    composer
                }.frame(maxWidth: 620).padding(12)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .background {
                // The renderer fills the home-indicator area; controls retain
                // the safe area. CanvasView clips its layers below the header.
                BlitzCanvasSurface(model: model)
                    .ignoresSafeArea(.container, edges: .bottom)
            }
            .overlay(alignment: .topTrailing) {
                if !showContextPicker && !modelPickerOpen { canvasTools.padding(12) }
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
        .task { await loadModels() }
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

    private var canSend: Bool {
        !sending && !changingModel && model.connected && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var hasComposerContext: Bool {
        promptScope != nil || !contextReferences.isEmpty || agentAssignment != .automatic
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 0) {
            if hasComposerContext {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        if case .specialist(let agent) = agentAssignment {
                            ComposerContextChip(label: agent.name, symbol: "", brand: "doop") {
                                agentAssignment = .automatic
                            }
                        }
                        if let scope = promptScope {
                            ComposerContextChip(label: scope.label, symbol: scope.isElement ? "scope" : "rectangle") {
                                dismissedScope = scope.key
                            }
                        }
                        ForEach(contextReferences) { reference in
                            ComposerContextChip(label: reference.name, symbol: reference.symbol) {
                                contextReferences.removeAll { $0.id == reference.id }
                            }
                        }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16).padding(.bottom, 8)
            }
            TextField(promptPlaceholder, text: $prompt, axis: .vertical)
                .lineLimit(1...5).textFieldStyle(.plain)
                .font(.callout).padding(.horizontal, 16)
                .focused($promptFocused)
                .accessibilityIdentifier("canvas.prompt")
                .onChange(of: promptFocused) { focused in if focused { modelPickerOpen = false } }
            HStack(spacing: 8) {
                Button {
                    if showContextPicker { closeContextPicker() }
                    else { modelPickerOpen = false; contextPickerOpen = true; dismissedMention = nil; promptFocused = false }
                } label: {
                    Image(systemName: "at").font(.system(size: 18, weight: .regular))
                        .foregroundStyle(ComposerColors.action)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Mention agents or context")
                .accessibilityIdentifier("canvas.addContext")
                Spacer(minLength: 0)
                Button {
                    closeContextPicker()
                    promptFocused = false
                    modelPickerOpen.toggle()
                    if modelPickerOpen { Task { await loadModels() } }
                } label: {
                    HStack(spacing: 6) {
                        ComposerBrandMark(name: modelAccount?.kind == "anthropic-key" ? "claude" : "chatgpt", color: ComposerColors.muted)
                            .frame(width: 14, height: 14)
                        Text(modelAccount?.label ?? "Auto")
                            .font(.subheadline)
                            .lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .foregroundStyle(ComposerColors.muted).padding(.horizontal, 8).frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(sending || changingModel)
                .accessibilityLabel("Choose model")
                .accessibilityValue(modelAccount?.label ?? "Auto")
                .accessibilityIdentifier("canvas.modelPicker")
                Button(action: sendPrompt) {
                    Group {
                        if sending { ProgressView().tint(.white) }
                        else { Image(systemName: "arrow.up").font(.system(size: 18, weight: .medium)) }
                    }
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(ComposerColors.send.opacity(canSend || sending ? 1 : 0.35), in: Circle())
                    .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!canSend)
                .accessibilityLabel("Send design task")
            }
        }
        // Pills already have 6 pt of space inside their taller touch target.
        .padding(.top, hasComposerContext ? 4 : 16)
        .padding(.bottom, 4)
        .disabled(sending)
        .modifier(ComposerGlass())
        .background(GeometryReader { proxy in Color.clear.preference(key: ComposerHeightKey.self, value: proxy.size.height) })
        .onPreferenceChange(ComposerHeightKey.self) { model.composerHeight = $0 }
    }

    private var modelPicker: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Doop Agent model").font(.subheadline).foregroundStyle(.secondary)
                Spacer()
                Button { modelPickerOpen = false } label: {
                    Image(systemName: "xmark").font(.caption).foregroundStyle(ComposerColors.action).frame(width: 44, height: 44)
                }.buttonStyle(.plain).accessibilityLabel("Close model picker")
            }.padding(.leading, 12)
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    if loadingModels || changingModel {
                        ProgressView(changingModel ? "Saving model…" : "Loading models…")
                            .padding(12).frame(maxWidth: .infinity)
                    }
                    if let modelError {
                        Text(modelError).font(.callout).foregroundStyle(.secondary).padding(.horizontal, 12)
                        Button("Retry") { Task { await loadModels() } }.padding(12)
                    }
                    if let account = modelAccount, !loadingModels {
                        if account.options.isEmpty {
                            Text(account.connected ? "No models are available for this account." :
                                 "Auto uses the server’s model. Connect a model account to choose your own.")
                                .font(.callout).foregroundStyle(.secondary).padding(12)
                        }
                        ForEach(account.options) { option in
                            Button { Task { await chooseModel(option.id) } } label: {
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(option.name).font(.body)
                                        if let blurb = option.blurb {
                                            Text(blurb).font(.caption).foregroundStyle(.secondary)
                                                .multilineTextAlignment(.leading)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                    if option.id == account.model { Image(systemName: "checkmark").font(.callout).foregroundStyle(ComposerColors.action) }
                                }
                                .padding(12).frame(minHeight: 48).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(changingModel)
                            .accessibilityLabel("Use " + option.name)
                            .accessibilityAddTraits(option.id == account.model ? [.isSelected] : [])
                        }
                    }
                }
            }.frame(height: modelAccount?.options.isEmpty == false ? 240 : 100)
            Divider().padding(.horizontal, 12)
            Link(modelAccount?.connected == true ? "Model settings…" : "Connect a model…",
                 destination: modelSettingsURL)
                .font(.callout).padding(12).frame(minHeight: 44)
        }
        .padding(8).modifier(ComposerGlass())
        .accessibilityIdentifier("canvas.modelOptions")
    }

    private var modelSettingsURL: URL {
        var url = URLComponents(url: model.client.server.origin.appendingPathComponent("settings"), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "pane", value: "agent")]
        return url.url!
    }

    private func loadModels() async {
        guard !loadingModels, !changingModel else { return }
        loadingModels = true
        defer { loadingModels = false }
        do {
            modelAccount = try await model.client.get("/api/model-account")
            modelError = nil
        } catch { modelError = error.localizedDescription }
    }

    private func chooseModel(_ id: String) async {
        guard !changingModel, modelAccount?.options.contains(where: { $0.id == id }) == true else { return }
        if id == modelAccount?.model { modelPickerOpen = false; return }
        changingModel = true
        defer { changingModel = false }
        do {
            let data = try await model.client.data("/api/model-account", method: "PATCH", body: ["model": id])
            modelAccount = try JSONDecoder().decode(AgentModelAccount.self, from: data)
            modelError = nil
            modelPickerOpen = false
        } catch { modelError = error.localizedDescription }
    }

    private var mentionQuery: String? { PromptContextReference.mentionQuery(in: prompt) }
    private var showContextPicker: Bool {
        contextPickerOpen || (promptFocused && mentionQuery != nil && dismissedMention != prompt)
    }
    private var availableContext: [PromptContextReference] {
        let people = PromptContextReference.people(currentUser: currentUser, presences: model.presences)
        let frames = (model.canvas?.frames ?? []).map { PromptContextReference(kind: .frame, sourceID: $0.id, name: $0.name) }
        let query = mentionQuery ?? ""
        return (people + frames).filter { item in
            !contextReferences.contains(where: { $0.id == item.id }) &&
                (query.isEmpty || item.name.localizedCaseInsensitiveContains(query))
        }
    }

    private var contextPicker: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Mention").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(action: closeContextPicker) {
                    Image(systemName: "xmark").font(.caption).foregroundStyle(ComposerColors.action).frame(width: 44, height: 44)
                }.buttonStyle(.plain).accessibilityLabel("Close context picker")
            }.padding(.leading, 12)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if !availableAgents.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Agents").font(.subheadline).foregroundStyle(.secondary)
                                .padding(.horizontal, 12).padding(.bottom, 4)
                            ForEach(availableAgents, id: \.self) { assignment in
                                Button { selectAgent(assignment) } label: {
                                    HStack(spacing: 12) {
                                        ComposerBrandMark(name: "doop").frame(width: 20, height: 20)
                                        Text(assignment == .automatic ? "Doop" : assignment.label)
                                            .lineLimit(2).multilineTextAlignment(.leading)
                                        Spacer(minLength: 0)
                                        if assignment == agentAssignment { Image(systemName: "checkmark").font(.caption).foregroundStyle(ComposerColors.action) }
                                    }
                                    .padding(.horizontal, 12).padding(.vertical, 8)
                                    .frame(minHeight: 48).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).disabled(sending)
                                .accessibilityLabel("Assign to " + (assignment == .automatic ? "Doop" : assignment.label))
                            }
                        }
                    }
                    ForEach(PromptContextReference.Kind.allCases, id: \.self) { kind in
                        let items = availableContext.filter { $0.kind == kind }
                        if !items.isEmpty {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(kind.sectionTitle).font(.subheadline).foregroundStyle(.secondary)
                                    .padding(.horizontal, 12).padding(.bottom, 4)
                                ForEach(items) { item in
                                    Button { addContext(item) } label: {
                                        HStack(spacing: 12) {
                                            if item.kind == .person {
                                                Text(item.name.split(separator: " ").prefix(2).compactMap { $0.first.map(String.init) }.joined())
                                                    .font(.caption.weight(.medium)).frame(width: 28, height: 28)
                                                    .background(Color.primary.opacity(0.08), in: Circle())
                                            } else {
                                                Image(systemName: item.symbol).font(.title3)
                                                    .foregroundStyle(ComposerColors.action).frame(width: 28)
                                            }
                                            Text(item.name).lineLimit(2).multilineTextAlignment(.leading)
                                            if item.kind == .person && item.sourceID == currentUser?.id {
                                                Text("(You)").foregroundStyle(.secondary)
                                            }
                                            Spacer(minLength: 0)
                                        }
                                        .padding(.horizontal, 12).padding(.vertical, 8)
                                        .frame(minHeight: 48).contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel("Add \(kind.rawValue) \(item.name)")
                                }
                            }
                        }
                    }
                    if availableContext.isEmpty && availableAgents.isEmpty {
                        Text("No matching context").foregroundStyle(.secondary).padding(12)
                    }
                }.padding(.bottom, 12)
            }.frame(height: promptFocused ? 180 : 260)
        }
        .padding(8).modifier(ComposerGlass())
        .accessibilityIdentifier("canvas.contextPicker")
        .disabled(sending)
    }

    private var availableAgents: [AgentAssignment] {
        let query = mentionQuery ?? ""
        return ([AgentAssignment.automatic] + SpecialistAgent.allCases.map { .specialist($0) }).filter {
            query.isEmpty || ($0 == .automatic ? "Doop" : $0.label).localizedCaseInsensitiveContains(query)
        }
    }

    private func selectAgent(_ assignment: AgentAssignment) {
        guard !sending else { return }
        agentAssignment = assignment
        finishContextSelection()
    }

    private func closeContextPicker() {
        contextPickerOpen = false
        dismissedMention = prompt
    }

    private func addContext(_ item: PromptContextReference) {
        guard !sending else { return }
        if !contextReferences.contains(where: { $0.id == item.id }) { contextReferences.append(item) }
        finishContextSelection()
    }

    private func finishContextSelection() {
        prompt = PromptContextReference.removingMentionQuery(from: prompt)
        dismissedMention = prompt
        contextPickerOpen = false
        promptFocused = true
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
        }.padding(.horizontal, 1).padding(.vertical, 4).modifier(FloatingGlass())
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
        guard canSend else { return }
        let value = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        sending = true
        let scope = promptScope?.scope
        let assignment = agentAssignment
        let title = PromptContextReference.taskTitle(value, references: contextReferences)
        Task {
            do {
                try await model.queue(title, scope: scope, assignment: assignment)
                prompt = ""
                contextReferences = []
                agentAssignment = .automatic
                contextPickerOpen = false
                promptFocused = false
                sheet = .tasks
            }
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
        }.padding(.horizontal, 4).padding(.vertical, 1)
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

private struct ComposerContextChip: View {
    @ScaledMetric(relativeTo: .subheadline) private var pillHeight = 32.0
    let label: String
    let symbol: String
    var brand: String? = nil
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            if let brand { ComposerBrandMark(name: brand, color: ComposerColors.muted).frame(width: 14, height: 14) }
            else { Image(systemName: symbol).font(.system(size: 14)).foregroundStyle(ComposerColors.muted) }
            Text(label).lineLimit(1).truncationMode(.tail)
            Button(action: dismiss) {
                Image(systemName: "xmark").font(.system(size: 10, weight: .medium))
                    .foregroundStyle(ComposerColors.muted).frame(width: 32, height: 44)
                    .contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Remove \(label) context")
        }
        .font(.subheadline)
        .padding(.leading, 10)
        .frame(minHeight: max(44, pillHeight))
        // Keep the visual pill compact without shrinking the remove control.
        .background(Capsule().fill(Color.primary.opacity(0.025)).frame(height: pillHeight))
        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.10), lineWidth: 1).frame(height: pillHeight))
        .frame(maxWidth: 260)
        .fixedSize(horizontal: true, vertical: false)
    }
}

/// Opaque neutral colors avoid compounding SwiftUI's secondary-style opacity
/// inside brand paths. The light/dark roles follow the composer reference.
private enum ComposerColors {
    static let action = adaptive(light: 0x383836, dark: 0xE6E5E3)
    static let muted = adaptive(light: 0x7C7A74, dark: 0xADA9A3)
    static let send = Color(red: 38 / 255, green: 131 / 255, blue: 222 / 255)

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            if traits.accessibilityContrast == .high { return .label }
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 255) / 255,
                           green: CGFloat((value >> 8) & 255) / 255,
                           blue: CGFloat(value & 255) / 255, alpha: 1)
        })
    }
}

/// Reuses the exact brand paths already used by native collaborator cursors.
private struct ComposerBrandMark: View {
    let name: String
    var color: Color = ComposerColors.action
    var body: some View {
        let source = AgentMark.path(for: name)
        let bounds = source.boundingBoxOfPath
        GeometryReader { proxy in
            let scale = min(proxy.size.width / bounds.width, proxy.size.height / bounds.height)
            let transform = CGAffineTransform(a: scale, b: 0, c: 0, d: scale,
                tx: (proxy.size.width - bounds.width * scale) / 2 - bounds.minX * scale,
                ty: (proxy.size.height - bounds.height * scale) / 2 - bounds.minY * scale)
            Path(source).applying(transform).fill(color)
        }.accessibilityHidden(true)
    }
}

private struct ComposerHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 160
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
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
