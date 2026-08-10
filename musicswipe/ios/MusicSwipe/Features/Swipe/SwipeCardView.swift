import SwiftUI

/// Карточка трека.
struct SwipeCardView: View {

    let track: Track
    let isTop: Bool
    let dragTranslation: CGSize

    /// Плеер передаётся только верхней карточке: остальные звук не трогают.
    let player: PreviewPlayer?

    /// Насколько далеко утащили карточку — от этого зависит прозрачность штампов.
    private var likeOpacity: Double {
        isTop ? min(Double(max(dragTranslation.width, 0)) / 110, 1) : 0
    }

    private var passOpacity: Double {
        isTop ? min(Double(max(-dragTranslation.width, 0)) / 110, 1) : 0
    }

    private var superlikeOpacity: Double {
        isTop ? min(Double(max(-dragTranslation.height, 0)) / 140, 1) : 0
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            ArtworkView(url: track.artworkURL, cornerRadius: Theme.cardCornerRadius)

            LinearGradient(
                colors: [.clear, .black.opacity(0.35), .black.opacity(0.88)],
                startPoint: .center,
                endPoint: .bottom
            )

            content
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.cardCornerRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Theme.cardCornerRadius, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
        }
        .overlay(alignment: .topLeading) { stamp(text: "НРАВИТСЯ", color: Theme.like, opacity: likeOpacity, angle: -14) }
        .overlay(alignment: .topTrailing) { stamp(text: "МИМО", color: Theme.pass, opacity: passOpacity, angle: 14) }
        .overlay(alignment: .top) { superlikeStamp }
        .shadow(color: .black.opacity(0.45), radius: 24, y: 12)
    }

    // MARK: - Содержимое

    private var content: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let reason = track.reason?.displayText {
                Label(reason, systemImage: "sparkles")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Theme.textPrimary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(.ultraThinMaterial, in: Capsule())
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(track.title)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(.white)
                    .lineLimit(2)

                HStack(spacing: 8) {
                    Text(track.artistName)
                        .font(.headline)
                        .foregroundStyle(.white.opacity(0.85))
                        .lineLimit(1)

                    if track.explicit {
                        Text("E")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.black)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(.white.opacity(0.8), in: RoundedRectangle(cornerRadius: 3))
                    }
                }

                if !track.subtitle.isEmpty {
                    Text(track.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.6))
                        .lineLimit(1)
                }
            }

            if !track.genres.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(track.genres.prefix(4), id: \.self) { genre in
                            GenreChip(title: genre)
                        }
                    }
                }
                .scrollDisabled(true)
            }

            if let player, isTop {
                PlaybackBar(player: player, hasPreview: track.previewURL != nil)
            } else {
                PlaybackBar.idle(hasPreview: track.previewURL != nil)
            }
        }
        .padding(22)
    }

    // MARK: - Штампы

    private func stamp(text: String, color: Color, opacity: Double, angle: Double) -> some View {
        Text(text)
            .font(.system(size: 26, weight: .heavy))
            .foregroundStyle(color)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(color, lineWidth: 4)
            }
            .rotationEffect(.degrees(angle))
            .opacity(opacity)
            .padding(24)
    }

    private var superlikeStamp: some View {
        Text("В ИЗБРАННОЕ")
            .font(.system(size: 22, weight: .heavy))
            .foregroundStyle(Theme.superlike)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Theme.superlike, lineWidth: 4)
            }
            .opacity(superlikeOpacity)
            .padding(.top, 90)
    }
}
