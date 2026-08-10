import SwiftUI

/// Кнопка воспроизведения и полоса прогресса превью.
///
/// Вынесено из карточки отдельным типом ради подписки на плеер: прогресс
/// обновляется десять раз в секунду, и перерисовывать из-за него всю карточку
/// с обложкой и текстом не нужно.
struct PlaybackBar: View {

    @ObservedObject var player: PreviewPlayer
    let hasPreview: Bool

    var body: some View {
        bar(
            isPlaying: player.isPlaying,
            progress: player.progress,
            isBuffering: player.isBuffering,
            action: { player.toggle() }
        )
    }

    /// Вариант для карточек под верхней — без подписки и без действий.
    static func idle(hasPreview: Bool) -> some View {
        IdlePlaybackBar(hasPreview: hasPreview)
    }

    @ViewBuilder
    private func bar(
        isPlaying: Bool,
        progress: Double,
        isBuffering: Bool,
        action: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 14) {
            Button(action: action) {
                ZStack {
                    Circle().fill(.white)
                    if isBuffering {
                        ProgressView().tint(.black)
                    } else {
                        Image(systemName: isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundStyle(.black)
                    }
                }
                .frame(width: 38, height: 38)
            }
            .buttonStyle(.plain)
            .disabled(!hasPreview)
            .opacity(hasPreview ? 1 : 0.4)

            VStack(alignment: .leading, spacing: 5) {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        Capsule().fill(.white.opacity(0.25))
                        Capsule()
                            .fill(.white)
                            .frame(width: max(0, geometry.size.width * progress))
                    }
                }
                .frame(height: 4)

                Text(hasPreview ? "30-секундный фрагмент" : "Превью недоступно")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.55))
            }
        }
    }
}

private struct IdlePlaybackBar: View {
    let hasPreview: Bool

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: "play.fill")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(.black)
                .frame(width: 38, height: 38)
                .background(.white, in: Circle())
                .opacity(hasPreview ? 1 : 0.4)

            VStack(alignment: .leading, spacing: 5) {
                Capsule()
                    .fill(.white.opacity(0.25))
                    .frame(height: 4)

                Text(hasPreview ? "30-секундный фрагмент" : "Превью недоступно")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.55))
            }
        }
    }
}
