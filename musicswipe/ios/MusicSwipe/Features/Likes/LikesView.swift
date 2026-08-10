import Combine
import SwiftUI

struct LikesView: View {

    @StateObject private var model = LikesViewModel()
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            ZStack {
                BackgroundView()

                Group {
                    if model.isLoading && model.tracks.isEmpty {
                        ProgressView().tint(Theme.accent)
                    } else if let error = model.errorMessage, model.tracks.isEmpty {
                        ErrorBanner(message: error) { Task { await model.load() } }
                            .padding(20)
                    } else if model.tracks.isEmpty {
                        EmptyStateView(
                            systemImage: "heart",
                            title: "Пока пусто",
                            message: "Свайпайте карточки вправо — понравившиеся треки соберутся здесь."
                        )
                    } else {
                        list
                    }
                }
            }
            .navigationTitle("Любимое")
            .toolbarBackground(Theme.background, for: .navigationBar)
        }
        .task { await model.load() }
        .onDisappear { model.stopPlayback() }
    }

    private var list: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                ForEach(model.tracks) { track in
                    LikedTrackRow(
                        track: track,
                        isPlaying: model.playingTrackID == track.id && model.isPlaying,
                        onTogglePlayback: { model.togglePlayback(for: track) },
                        onOpen: {
                            if let url = track.externalURL { openURL(url) }
                        }
                    )
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .refreshable { await model.load() }
    }
}

struct LikedTrackRow: View {

    let track: LikedTrack
    let isPlaying: Bool
    let onTogglePlayback: () -> Void
    let onOpen: () -> Void

    private var metadata: String {
        [track.genres.first, track.durationSec?.asDuration, track.releaseYear.map(String.init)]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                ArtworkView(url: track.artworkURL, cornerRadius: 10)
                    .frame(width: 58, height: 58)

                if track.previewURL != nil {
                    Button(action: onTogglePlayback) {
                        Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 28, height: 28)
                            .background(.black.opacity(0.55), in: Circle())
                    }
                    .buttonStyle(.plain)
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(track.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(1)

                    if track.superliked {
                        Image(systemName: "star.fill")
                            .font(.caption2)
                            .foregroundStyle(Theme.superlike)
                    }
                }

                Text(track.artistName)
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)

                if !metadata.isEmpty {
                    Text(metadata)
                        .font(.caption2)
                        .foregroundStyle(Theme.textTertiary)
                }
            }

            Spacer(minLength: 8)

            if track.externalURL != nil {
                Button(action: onOpen) {
                    Image(systemName: "arrow.up.forward.square")
                        .font(.system(size: 17))
                        .foregroundStyle(Theme.textSecondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(10)
        .cardStyle(cornerRadius: 16)
    }
}

@MainActor
final class LikesViewModel: ObservableObject {

    @Published private(set) var tracks: [LikedTrack] = []
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var playingTrackID: UUID?
    /// Зеркало состояния плеера: список — не карточка, ему хватает одного флага,
    /// а подписываться на вложенный ObservableObject из SwiftUI напрямую нельзя.
    @Published private(set) var isPlaying = false

    let player = PreviewPlayer()

    private let repository = MusicRepository()

    init() {
        player.$isPlaying.assign(to: &$isPlaying)
    }

    func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            tracks = try await repository.likedTracks()
        } catch {
            errorMessage = (error as? SupabaseError)?.errorDescription ?? error.localizedDescription
        }
    }

    func togglePlayback(for track: LikedTrack) {
        guard let url = track.previewURL else { return }

        if playingTrackID == track.id {
            player.toggle()
        } else {
            playingTrackID = track.id
            player.load(url: url)
        }
    }

    func stopPlayback() {
        player.stop()
        playingTrackID = nil
    }
}
