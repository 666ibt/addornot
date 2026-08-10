import SwiftUI

struct ImportPlaylistView: View {

    /// В онбординге экран занимает всё окно, из профиля открывается модально.
    let isOnboarding: Bool
    let onFinished: () -> Void

    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = ImportViewModel()

    init(isOnboarding: Bool, onFinished: @escaping () -> Void) {
        self.isOnboarding = isOnboarding
        self.onFinished = onFinished
    }

    var body: some View {
        ZStack {
            if !isOnboarding { BackgroundView() }

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header

                    if let result = model.result {
                        resultCard(result)
                    } else {
                        inputSection
                        platformsSection
                    }

                    if let error = model.errorMessage {
                        ErrorBanner(message: error) {
                            model.clearError()
                        }
                    }
                }
                .padding(24)
                .padding(.top, isOnboarding ? 32 : 0)
            }
            .scrollDismissesKeyboard(.interactively)

            if model.isImporting {
                ImportProgressOverlay(stage: model.progressStage)
            }
        }
        .navigationTitle(isOnboarding ? "" : "Импорт плейлиста")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Части экрана

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(isOnboarding ? "С чего начнём" : "Добавить плейлист")
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(Theme.textPrimary)

            Text("Пришлите ссылку на плейлист с любой платформы. Мы разберём его, "
                 + "поймём ваш вкус и соберём ленту из треков, которых там ещё нет.")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
        }
    }

    private var inputSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Image(systemName: model.detectedPlatform?.systemImage ?? "link")
                    .foregroundStyle(model.detectedPlatform == nil ? Theme.textTertiary : Theme.accent)
                    .frame(width: 22)

                TextField("https://open.spotify.com/playlist/…", text: $model.url, axis: .vertical)
                    .lineLimit(1...3)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .foregroundStyle(Theme.textPrimary)

                if !model.url.isEmpty {
                    Button {
                        model.url = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Theme.textTertiary)
                    }
                }
            }
            .padding(16)
            .cardStyle(cornerRadius: 16)

            if let platform = model.detectedPlatform {
                Label("Определили платформу: \(platform.displayName)", systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.like)
            }

            HStack(spacing: 12) {
                Button {
                    model.pasteFromClipboard()
                } label: {
                    Label("Вставить", systemImage: "doc.on.clipboard")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .foregroundStyle(Theme.textPrimary)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
            }

            PrimaryButton(
                title: "Анализировать плейлист",
                systemImage: "wand.and.stars",
                isLoading: model.isImporting,
                isEnabled: model.canImport
            ) {
                Task { await model.importPlaylist() }
            }

            Text("Разбор большого плейлиста занимает до минуты — мы обращаемся "
                 + "к музыкальным каталогам и подбираем первые тридцать карточек.")
                .font(.caption)
                .foregroundStyle(Theme.textTertiary)
        }
    }

    private var platformsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Поддерживаемые сервисы")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 10)], spacing: 10) {
                ForEach(MusicPlatform.allCases, id: \.self) { platform in
                    Label(platform.displayName, systemImage: platform.systemImage)
                        .font(.subheadline)
                        .foregroundStyle(Theme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 12)
                        .padding(.horizontal, 14)
                        .cardStyle(cornerRadius: 14)
                }
            }
        }
    }

    private func resultCard(_ result: ImportPlaylistResult) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 14) {
                ArtworkView(url: result.playlist.coverUrl.flatMap(URL.init(string:)))
                    .frame(width: 72, height: 72)

                VStack(alignment: .leading, spacing: 4) {
                    Text(result.playlist.title ?? "Ваш плейлист")
                        .font(.headline)
                        .foregroundStyle(Theme.textPrimary)
                        .lineLimit(2)

                    Text("\(result.playlist.platform.displayName) · \(result.playlist.trackCount) треков")
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
                Spacer()
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Что мы поняли о вашем вкусе")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)

                if result.taste.topGenres.isEmpty {
                    Text("Жанры определить не удалось — лента соберётся по исполнителям.")
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                } else {
                    TasteBars(values: result.taste.topGenres.map { ($0.genre, $0.weight) })
                }

                if let year = result.taste.avgYear {
                    Text("Средний год выпуска: \(Int(year.rounded()))")
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                }
            }

            Divider().overlay(Color.white.opacity(0.1))

            HStack(spacing: 20) {
                statistic(value: "\(result.playlist.matchedCount)", caption: "распознано")
                statistic(value: "\(result.deckPrepared)", caption: "карточек готово")
            }

            PrimaryButton(title: "Начать свайпать", systemImage: "flame.fill") {
                onFinished()
                if !isOnboarding { dismiss() }
            }
        }
        .padding(20)
        .cardStyle()
    }

    private func statistic(value: String, caption: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.title2.weight(.bold))
                .foregroundStyle(Theme.accent)
            Text(caption)
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
        }
    }
}

/// Горизонтальные полоски весов жанров.
struct TasteBars: View {
    let values: [(String, Double)]

    var body: some View {
        let maxWeight = max(values.map(\.1).max() ?? 1, 0.0001)

        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(values.enumerated()), id: \.offset) { _, item in
                HStack(spacing: 10) {
                    Text(item.0)
                        .font(.caption)
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: 90, alignment: .leading)
                        .lineLimit(1)

                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            Capsule()
                                .fill(Color.white.opacity(0.08))
                            Capsule()
                                .fill(Theme.brandGradient)
                                .frame(width: max(8, geometry.size.width * item.1 / maxWeight))
                        }
                    }
                    .frame(height: 8)
                }
            }
        }
    }
}

/// Затемнение с бегущими подписями на время долгого импорта.
struct ImportProgressOverlay: View {
    let stage: String

    var body: some View {
        ZStack {
            Color.black.opacity(0.65).ignoresSafeArea()

            VStack(spacing: 18) {
                ProgressView()
                    .controlSize(.large)
                    .tint(Theme.accent)

                Text(stage)
                    .font(.subheadline)
                    .foregroundStyle(Theme.textPrimary)
                    .multilineTextAlignment(.center)
                    .animation(.easeInOut, value: stage)
            }
            .padding(28)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .padding(40)
        }
    }
}
