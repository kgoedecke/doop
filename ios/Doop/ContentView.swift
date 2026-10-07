import SwiftUI

private let doopBlue = Color(red: 39/255, green: 67/255, blue: 238/255)

struct ContentView: View {
    @StateObject private var app = AppModel()
    @State private var settings = false

    var body: some View {
        Group {
            if app.loading {
                VStack(spacing: 20) { DoopWordmark(); ProgressView("Opening your workspace…") }
            } else if app.user == nil {
                SignInView(app: app, settings: $settings)
            } else {
                LibraryView(app: app, settings: $settings)
            }
        }
        .tint(doopBlue)
        .task { await app.restore() }
        .sheet(isPresented: $settings) { NativeSettings(app: app).tint(doopBlue) }
    }
}

private struct DoopWordmark: View {
    var body: some View {
        HStack(spacing: 10) {
            Image("AppMark").resizable().frame(width: 34, height: 34).clipShape(RoundedRectangle(cornerRadius: 9))
                .accessibilityHidden(true)
            Text("doop").font(.system(size: 28, weight: .heavy, design: .rounded))
        }
    }
}

private struct SignInView: View {
    @ObservedObject var app: AppModel
    @Binding var settings: Bool
    @State private var email = ""
    @State private var password = ""
    @State private var name = ""
    @State private var registering = false
    @State private var submitting = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    DoopWordmark().padding(.top, 32)
                    VStack(alignment: .leading, spacing: 10) {
                        Text(registering ? "Make room for\nyour next idea." : "Your ideas.\nAnywhere.")
                            .font(.system(size: 42, weight: .bold, design: .rounded)).fixedSize(horizontal: false, vertical: true)
                        Text("A shared design space for you, your team, and your agents.")
                            .font(.title3).foregroundStyle(.secondary)
                    }
                    VStack(spacing: 16) {
                        if registering {
                            TextField("Your name", text: $name).textContentType(.name)
                        }
                        TextField("Email", text: $email).textContentType(.username).keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("login.email")
                        SecureField("Password", text: $password).textContentType(registering ? .newPassword : .password)
                            .accessibilityIdentifier("login.password")
                    }.textFieldStyle(.roundedBorder).controlSize(.large)
                    if let message = error ?? app.error { Text(message).font(.callout).foregroundStyle(.red) }
                    Button {
                        submitting = true
                        error = nil
                        Task {
                            do { try await app.signIn(email: email, password: password, name: registering ? name : nil); password = "" }
                            catch { self.error = error.localizedDescription }
                            submitting = false
                        }
                    } label: {
                        HStack { Spacer(); if submitting { ProgressView().tint(.white) }; Text(registering ? "Create account" : "Sign in").bold(); Spacer() }.padding(.vertical, 8)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(submitting || email.isEmpty || password.isEmpty || (registering && name.trimmingCharacters(in: .whitespaces).isEmpty))
                    .accessibilityIdentifier("login.submit")
                    Button(registering ? "Already have an account? Sign in" : "New to Doop? Create an account") { registering.toggle(); error = nil }
                    Text(app.client.server.origin.host ?? "").font(.caption).foregroundStyle(.tertiary)
                }
                .padding(28).frame(maxWidth: 480).frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .toolbar { ToolbarItem(placement: .primaryAction) { Button { settings = true } label: { Image(systemName: "gearshape") }.accessibilityLabel("Server settings") } }
        }
    }
}

private struct LibraryView: View {
    @ObservedObject var app: AppModel
    @Binding var settings: Bool
    @State private var query = ""
    @State private var searching = false
    @State private var showingAgents = false
    @FocusState private var searchFocused: Bool
    @State private var workspace = "all"
    @State private var path: [CanvasSummary] = []
    @State private var creating = false
    @State private var title = ""
    @State private var deleting: CanvasSummary?
    @State private var renaming: CanvasSummary?
    @State private var busy = false

    private var filtered: [CanvasSummary] {
        app.canvases.filter { canvas in
            (query.isEmpty || canvas.name.localizedCaseInsensitiveContains(query)) &&
            (workspace == "all" || (workspace == "personal" ? canvas.workspaceId == nil : canvas.workspaceId == workspace))
        }
    }

    var body: some View {
        GeometryReader { geometry in
        NavigationStack(path: $path) {
            Group {
                if showingAgents {
                    WorkingAgentsView(client: app.client) { canvas in path.append(canvas) }
                } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("YOUR DESIGN SPACE").font(.caption.weight(.semibold)).tracking(2).foregroundStyle(doopBlue)
                        Text("What’s next, \(app.user?.name.components(separatedBy: " ").first ?? "designer")?")
                            .font(.system(.largeTitle, design: .rounded).bold())
                        Text("Pick up an idea. Or start something new.").foregroundStyle(.secondary)
                    }.padding(.top, 12)
                    HStack {
                        Picker("Workspace", selection: $workspace) {
                            Text("All canvases").tag("all")
                            Text("Personal").tag("personal")
                            ForEach(app.workspaces) { Text($0.name).tag($0.id) }
                        }.pickerStyle(.menu)
                        Spacer()
                        Text("\(filtered.count) \(filtered.count == 1 ? "canvas" : "canvases")").font(.caption).foregroundStyle(.secondary)
                    }
                    if let error = app.error { Text(error).foregroundStyle(.red).font(.callout) }
                    if filtered.isEmpty {
                        VStack(spacing: 12) {
                            Image(systemName: query.isEmpty ? "square.stack.3d.up" : "magnifyingglass").font(.largeTitle).foregroundStyle(doopBlue)
                            Text(query.isEmpty ? "Your next idea starts here." : "No matching canvases").font(.headline)
                            if query.isEmpty { Button("Create a canvas") { title = ""; creating = true }.buttonStyle(.borderedProminent) }
                        }.frame(maxWidth: .infinity).padding(.vertical, 60)
                    }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 20)], spacing: 20) {
                        ForEach(filtered) { canvas in
                            NavigationLink(value: canvas) { CanvasCard(canvas: canvas, origin: app.client.server.origin) }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    Button("Rename") { title = canvas.name; renaming = canvas }
                                    Button("Duplicate") { duplicate(canvas) }
                                    if canvas.ownerId == app.user?.id { Button("Delete", role: .destructive) { deleting = canvas } }
                                }
                        }
                    }
                }.padding(24).frame(maxWidth: 1200).frame(maxWidth: .infinity)
            }
                }
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle(showingAgents ? "Agents" : "").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Image("AppMark").resizable().frame(width: 26, height: 26)
                        .clipShape(RoundedRectangle(cornerRadius: 6)).accessibilityLabel("Doop")
                }
                ToolbarItemGroup(placement: .navigationBarTrailing) {
                    if !showingAgents {
                    Button { title = ""; creating = true } label: { Image(systemName: "plus") }
                        .disabled(busy).accessibilityLabel("New canvas")
                    Button { searching.toggle(); searchFocused = searching; if !searching { query = "" } } label: {
                        Image(systemName: "magnifyingglass")
                    }.accessibilityLabel("Search canvases")
                    }
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if searching && !showingAgents { librarySearchBar.padding(.horizontal, 20).padding(.vertical, 8) }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                libraryDock.offset(y: geometry.safeAreaInsets.bottom < 80 ? max(0, geometry.safeAreaInsets.bottom - 16) : 0)
            }
            .refreshable { await app.reload() }
            .task {
                await app.reload()
                #if DEBUG
                // -openCanvas <id> jumps straight to a canvas (simulator automation).
                if path.isEmpty, let id = UserDefaults.standard.string(forKey: "openCanvas"), let canvas = app.canvases.first(where: { $0.id == id }) {
                    path.append(canvas)
                }
                #endif
            }

            .navigationDestination(for: CanvasSummary.self) { canvas in NativeCanvasView(summary: canvas, client: app.client) }
            .alert("New canvas", isPresented: $creating) {
                TextField("Canvas name", text: $title)
                Button("Cancel", role: .cancel) {}
                Button("Create") { create() }
            }
            .alert("Rename canvas", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Canvas name", text: $title)
                Button("Cancel", role: .cancel) { renaming = nil }
                Button("Save") { if let canvas = renaming { rename(canvas) }; renaming = nil }
            }
            .confirmationDialog("Delete this canvas and its frames?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
                Button("Delete canvas", role: .destructive) { if let canvas = deleting { remove(canvas) }; deleting = nil }
            }
            .overlay { if busy { ProgressView().padding(24).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20)) } }
        }
    }
    }

    private var librarySearchBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Find a canvas", text: $query).focused($searchFocused)
                .submitLabel(.search).accessibilityLabel("Find a canvas")
            Button { query = ""; searching = false } label: { Image(systemName: "xmark.circle.fill") }
                .accessibilityLabel("Close search")
        }.padding(16).modifier(FloatingGlass()).frame(maxWidth: 600)
            .frame(maxWidth: .infinity)
    }

    private var libraryDock: some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                GlassDock {
                    GlassDockButton(label: "Canvases", symbol: "square.grid.2x2.fill", selected: !showingAgents) {
                        showingAgents = false; searching = false; query = ""
                    }
                    GlassDockButton(label: "Working agents", symbol: "sparkles", caption: "Agents", selected: showingAgents) { showingAgents = true; searchFocused = false }
                }
                Button { settings = true } label: {
                    Text(String(app.user?.name.prefix(1) ?? "D")).font(.title3.bold())
                        .frame(width: 48, height: 48)
                        .background(Color.accentColor.opacity(0.15), in: Circle()).padding(6)
                }.buttonStyle(.plain).modifier(FloatingGlass()).accessibilityLabel("Account and settings")
            }
        }.frame(maxWidth: 600).padding(.horizontal, 20).padding(.top, 10)
            .frame(maxWidth: .infinity)
    }

    private func create() {
        busy = true
        Task {
            do {
                let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
                let canvas = try await app.createCanvas(name: name.isEmpty ? "Untitled canvas" : name, workspaceId: workspace == "all" || workspace == "personal" ? nil : workspace)
                path.append(canvas)
            } catch { app.error = error.localizedDescription }
            busy = false
        }
    }
    private func duplicate(_ canvas: CanvasSummary) {
        Task {
            do { _ = try await app.client.data("/api/canvases/\(canvas.id)/duplicate", method: "POST"); await app.reload() }
            catch { app.error = error.localizedDescription }
        }
    }
    private func rename(_ canvas: CanvasSummary) {
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        Task {
            do { _ = try await app.client.data("/api/canvases/\(canvas.id)", method: "PATCH", body: ["name": name]); await app.reload() }
            catch { app.error = error.localizedDescription }
        }
    }
    private func remove(_ canvas: CanvasSummary) {
        Task {
            do { _ = try await app.client.data("/api/canvases/\(canvas.id)", method: "DELETE"); await app.reload() }
            catch { app.error = error.localizedDescription }
        }
    }
}

private struct CanvasCard: View {
    let canvas: CanvasSummary
    let origin: URL
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                Color(uiColor: .secondarySystemGroupedBackground)
                if let frameID = canvas.previewFrameId {
                    GeometryReader { geometry in
                        AsyncImage(url: origin.appendingPathComponent("i/\(frameID).jpg").appending(queryItems: [URLQueryItem(name: "preview", value: "")])) { image in
                            image.resizable().scaledToFill()
                                .frame(width: geometry.size.width, height: geometry.size.height).clipped()
                        } placeholder: {
                            placeholder.frame(width: geometry.size.width, height: geometry.size.height)
                        }
                    }
                } else { placeholder }
            }.frame(height: 180).clipped()
            VStack(alignment: .leading, spacing: 8) {
                Text(canvas.name).font(.headline).lineLimit(2)
                HStack {
                    Text("\(canvas.frameCount) \(canvas.frameCount == 1 ? "frame" : "frames")")
                    Spacer()
                    Text(Date(timeIntervalSince1970: canvas.updatedAt / 1000).formatted(.relative(presentation: .named)))
                }.font(.caption).foregroundStyle(.secondary)
                if canvas.shared == true { Label("Shared with you", systemImage: "person.2").font(.caption2).foregroundStyle(doopBlue) }
            }.padding(18)
        }
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(.primary.opacity(0.06)))
    }
    private var placeholder: some View { Image(systemName: "square.stack.3d.up").font(.system(size: 42, weight: .ultraLight)).foregroundStyle(doopBlue.opacity(0.5)) }
}

private struct NativeSettings: View {
    @ObservedObject var app: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var error: String?
    @State private var busy = false
    @State private var confirmingDeletion = false
    @State private var deletionPassword = ""
    var body: some View {
        NavigationStack {
            Form {
                Section { DoopWordmark().padding(.vertical, 12) }
                if let user = app.user {
                    Section("Account") {
                        LabeledContent("Name", value: user.name)
                        LabeledContent("Email", value: user.email)
                        Link("Manage model accounts on the web", destination: app.client.server.origin.appendingPathComponent("settings"))
                        Button("Sign out", role: .destructive) {
                            busy = true
                            Task { do { try await app.signOut(); dismiss() } catch { self.error = error.localizedDescription }; busy = false }
                        }.disabled(busy)
                    }
                    Section {
                        Button("Delete account…", role: .destructive) { confirmingDeletion = true }.disabled(busy)
                    } footer: {
                        Text("Deletes your account on this server. Canvases only you own are removed; canvases shared with others stay with them.")
                    }
                    .alert("Delete your account?", isPresented: $confirmingDeletion) {
                        SecureField("Password", text: $deletionPassword)
                        Button("Delete", role: .destructive) {
                            busy = true
                            let password = deletionPassword
                            deletionPassword = ""
                            Task {
                                do { try await app.deleteAccount(password: password); dismiss() } catch { self.error = error.localizedDescription }
                                busy = false
                            }
                        }
                        Button("Cancel", role: .cancel) { deletionPassword = "" }
                    } message: {
                        Text("This cannot be undone. Enter your password to confirm.")
                    }
                }
                Section {
                    Link("Privacy policy", destination: app.client.server.origin.appendingPathComponent("privacy"))
                    Link("Terms of service", destination: app.client.server.origin.appendingPathComponent("terms"))
                    Link("Contact support, or report a canvas", destination: URL(string: "mailto:support@doop.design?subject=Doop%20for%20iOS")!)
                } header: { Text("Help") }
                Section {
                    TextField("https://doop.design", text: $address).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityLabel("Doop server address")
                    Button("Use Doop Cloud") { address = "https://doop.design" }
                } header: { Text("Server") } footer: { Text("Doop Cloud or your own HTTPS server. Your account and canvases stay on that server.") }
                if let error { Section { Text(error).foregroundStyle(.red) } }
                Section { Text("Built for iPhone and iPad. Native controls, live HTML designs.").foregroundStyle(.secondary) }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        guard let server = ServerAddress(address) else { return }
                        if server != app.client.server { Task { await app.changeServer(server) } }
                        dismiss()
                    }.disabled(ServerAddress(address) == nil || busy)
                }
            }.onAppear { address = app.client.server.origin.absoluteString }
        }
    }
}


struct WorkingAgentsView: View {
    let client: DoopClient
    let openCanvas: (CanvasSummary) -> Void
    @Environment(\.scenePhase) private var scenePhase
    @State private var canvases: [CanvasSummary] = []
    @State private var loading = true
    @State private var error: String?
    @State private var updatedAt: Date?

    private var activeCanvases: [CanvasSummary] {
        canvases.filter { !($0.activeTasks ?? []).isEmpty }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    private var workingCount: Int {
        canvases.reduce(0) { $0 + Set(($1.activeTasks ?? []).filter { !$0.agentName.isEmpty }.map(\.agentName)).count }
    }
    private var queuedCount: Int {
        canvases.reduce(0) { $0 + ($1.activeTasks ?? []).filter { $0.agentName.isEmpty }.count }
    }

    var body: some View {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Across your canvases").font(.subheadline).foregroundStyle(.secondary)
                        Text("\(workingCount) working").font(.largeTitle.bold())
                        Text("\(queuedCount) queued").foregroundStyle(.secondary)
                        if let updatedAt {
                            Text("Updated \(updatedAt.formatted(date: .omitted, time: .standard))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(.top, 12)
                    if let error {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(error).foregroundStyle(.orange)
                            Button("Try again") { Task { await refresh() } }
                        }
                    }
                    if loading { ProgressView("Checking agent activity…").frame(maxWidth: .infinity) }
                    else if error == nil && activeCanvases.isEmpty {
                        VStack(spacing: 12) {
                            Image(systemName: "sparkles").font(.largeTitle).foregroundStyle(.tint)
                            Text("All quiet for now").font(.headline)
                            Text("Agents appear here when they start working. Open a canvas to give your team a task.")
                                .foregroundStyle(.secondary).multilineTextAlignment(.center)
                        }.frame(maxWidth: .infinity).padding(.vertical, 44)
                    }
                    ForEach(activeCanvases) { canvas in
                        VStack(alignment: .leading, spacing: 16) {
                            Button { openCanvas(canvas) } label: {
                                HStack {
                                    Text(canvas.name).font(.headline)
                                    Spacer()
                                    Image(systemName: "arrow.up.right")
                                }
                            }.accessibilityLabel("Open \(canvas.name)")
                            ForEach((canvas.activeTasks ?? []).sorted { $0.startedAt > $1.startedAt }) { task in
                                HStack(alignment: .top, spacing: 12) {
                                    Image(systemName: task.agentName.isEmpty ? "clock" : "sparkles")
                                        .foregroundStyle(task.agentName.isEmpty ? .orange : .blue)
                                        .frame(width: 36, height: 36)
                                        .background(Color.accentColor.opacity(0.08), in: Circle())
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack {
                                            Text(task.agentName.isEmpty ? "Waiting for an agent" : task.agentName).font(.subheadline.bold())
                                            Spacer()
                                            Text(Date(timeIntervalSince1970: task.startedAt / 1000), style: .relative)
                                                .font(.caption).foregroundStyle(.secondary)
                                        }
                                        Text(task.status).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                                        if let pipeline = task.pipeline, pipeline.count > 1 {
                                            let stage = task.stage ?? 0
                                            if stage >= 0 && stage < pipeline.count {
                                                Text("Stage \(stage + 1) of \(pipeline.count)").font(.caption).foregroundStyle(.secondary)
                                            }
                                        }
                                    }
                                }
                            }
                        }.padding(20).background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 24))
                    }
                }.padding(24).frame(maxWidth: 1200).frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .refreshable { await refresh() }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    await refresh()
                    do { try await Task.sleep(nanoseconds: 5_000_000_000) } catch { return }
                }
            }
    }

    @MainActor private func refresh() async {
        do {
            let result: [CanvasSummary] = try await client.get("/api/canvases")
            guard !Task.isCancelled else { return }
            // An older server must not look like an idle team.
            guard result.isEmpty || result.allSatisfy({ $0.activeTasks != nil }) else {
                canvases = []; updatedAt = nil
                error = "Update your Doop server to see working agents here."
                loading = false
                return
            }
            canvases = result; updatedAt = Date(); error = nil
        } catch {
            guard !Task.isCancelled else { return }
            canvases = []; updatedAt = nil
            self.error = error.localizedDescription
        }
        loading = false
    }
}
