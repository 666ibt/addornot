import SwiftUI

struct ProfileView: View {

    @EnvironmentObject private var client: SupabaseClient
    @StateObject private var model = ProfileViewModel()
    @State private var showImport = false
    @State private var showSignOutConfirmation = false

    var body: some View {
        NavigationStack {
            ZStack {
                BackgroundView()

                ScrollView {
                    VStack(spacing: 20) {
                        accountCard
                        tasteCard
                        playlistsCard

                        if let error = model.errorMessage {
                            ErrorBanner(message: error) { model.clearError() }
                        }

                        actions
                    }
                    .padding(20)
                }
                .refreshable { await model.load() }
            }
            .navigationTitle("Профиль")
            .toolbarBackground(Theme.background, for: .navigationBar)
        }
        .task { await model.load() }
        .sheet(isPresented: $showImport) {
            NavigationStack {
                ImportPlaylistView(isOnboarding: false) {
                    Task { await model.load() }
                }
            }
            .presentationDragIndicator(.visible)
        }
        .confirmationDialog(
            "Выйти из аккаунта?",
            isPresented: $showSignOutConfirmation,
            titleVisibility: .visible
        ) {
            Button("Выйти", role: .destructive) {
                Task { await client.signOut() }
            }
            Button("Отмена", role: .cancel) {}
        } message: {
            if client.session?.user.isAnonymous == true {
                Text("Аккаунт гостевой — после выхода лайки и профиль восстановить не получится.")
            }
        }
    }

    // MARK: - Карточки

    private var accountCard: some View {
        HStack(spacing: 14) {
            Circle()
                .fill(Theme.brandGradient)
                .frame(width: 54, height: 54)
                .overlay {
                    Image(systemName: "person.fill")
                        .font(.system(size: 22))
                        .foregroundStyle(.white)
                }

            VStack(alignment: .leading, spacing: 3) {
                Text(client.session?.user.email ?? "Гостевой аккаунт")
                    .font(.headline)
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)

                Text("Лайков: \(model.likesCount)")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            }

            Spacer()
        }
        .padding(16)
        .cardStyle()
    }

    private var tasteCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Ваш вкус")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)

            if model.isLoading && model.taste.isEmpty {
                ProgressView().tint(Theme.accent)
            } else if model.taste.isEmpty {
                Text("Профиль соберётся после импорта плейлиста и первых свайпов.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
            } else {
                TasteBars(values: model.taste.map { ($0.genre, $0.weight) })
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .cardStyle()
    }

    private var playlistsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Плейлисты")
                    .font(.headline)
                    .foregroundStyle(Theme.textPrimary)

                Spacer()

                Button {
                    showImport = true
                } label: {
                    Label("Добавить", systemImage: "plus")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                }
            }

            if model.playlists.isEmpty {
                Text("Пока ни одного. Добавьте ссылку — лента станет точнее.")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
            } else {
                ForEach(model.playlists) { playlist in
                    PlaylistRow(playlist: playlist)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .cardStyle()
    }

    private var actions: some View {
        VStack(spacing: 12) {
            PrimaryButton(
                title: "Пересобрать вкусовой профиль",
                systemImage: "arrow.triangle.2.circlepath",
                isLoading: model.isRebuilding
            ) {
                Task { await model.rebuildProfile() }
            }

            Text("Пересборка заново считает веса по плейлистам и лайкам "
                 + "и обновляет очередь рекомендаций.")
                .font(.caption)
                .foregroundStyle(Theme.textTertiary)
                .multilineTextAlignment(.center)

            Button {
                showSignOutConfirmation = true
            } label: {
                Text("Выйти")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.pass)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
        }
    }
}

struct PlaylistRow: View {
    let playlist: PlaylistSummary

    var body: some View {
        HStack(spacing: 12) {
            ArtworkView(url: playlist.coverURL, cornerRadius: 8)
                .frame(width: 46, height: 46)

            VStack(alignment: .leading, spacing: 3) {
                Text(playlist.displayTitle)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)

                Text("\(playlist.platform.displayName) · \(playlist.matchedCount) из \(playlist.trackCount) распознано")
                    .font(.caption2)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            statusIcon
        }
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch playlist.status {
        case "ready":
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.like)
        case "failed":
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.pass)
        default:
            ProgressView().controlSize(.small).tint(Theme.accent)
        }
    }
}
