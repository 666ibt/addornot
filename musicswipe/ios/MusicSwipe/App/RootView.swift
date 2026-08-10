import SwiftUI

/// Развилка приложения: настройка -> вход -> импорт плейлиста -> лента.
struct RootView: View {

    @EnvironmentObject private var client: SupabaseClient
    @StateObject private var flow = AppFlowViewModel()

    var body: some View {
        ZStack {
            BackgroundView()

            if !client.isConfigured {
                ConfigurationNeededView()
            } else if client.isRestoring {
                SplashView()
            } else if client.session == nil {
                AuthView()
                    .transition(.opacity)
            } else {
                switch flow.stage {
                case .checking:
                    SplashView()
                case .needsPlaylist:
                    ImportPlaylistView(isOnboarding: true) {
                        flow.playlistImported()
                    }
                    .transition(.opacity)
                case .ready:
                    MainTabView()
                        .transition(.opacity)
                }
            }
        }
        .animation(.easeInOut(duration: 0.25), value: client.session)
        .animation(.easeInOut(duration: 0.25), value: flow.stage)
        .task {
            await client.restoreSession()
        }
        .task(id: client.session?.user.id) {
            guard client.session != nil else {
                flow.reset()
                return
            }
            await flow.refresh()
        }
    }
}

/// Отвечает на один вопрос: есть ли у пользователя разобранный плейлист.
/// Пока ответа нет — показываем сплэш, чтобы не мигать экраном импорта.
@MainActor
final class AppFlowViewModel: ObservableObject {

    enum Stage: Equatable {
        case checking
        case needsPlaylist
        case ready
    }

    @Published private(set) var stage: Stage = .checking

    private let repository = MusicRepository()

    func refresh() async {
        do {
            let playlists = try await repository.playlists()
            stage = playlists.contains { $0.status == "ready" } ? .ready : .needsPlaylist
        } catch {
            // Не смогли проверить — предлагаем импорт: он всё равно первый шаг.
            stage = .needsPlaylist
        }
    }

    func playlistImported() {
        stage = .ready
    }

    func reset() {
        stage = .checking
    }
}

struct SplashView: View {
    @State private var pulse = false

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "waveform")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(Theme.brandGradient)
                .scaleEffect(pulse ? 1.08 : 0.92)
                .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: pulse)

            Text("MusicSwipe")
                .font(.title2.weight(.bold))
                .foregroundStyle(Theme.textPrimary)
        }
        .onAppear { pulse = true }
    }
}

/// Экран для случая «забыли положить Supabase.plist».
struct ConfigurationNeededView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Приложение не настроено")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(Theme.textPrimary)

                Text("Создайте файл `MusicSwipe/Core/Config/Supabase.plist` по образцу "
                     + "`Supabase.example.plist` и укажите в нём адрес проекта и anon-ключ "
                     + "(Supabase → Project Settings → API).")
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)

                VStack(alignment: .leading, spacing: 8) {
                    Text("cp MusicSwipe/Core/Config/Supabase.example.plist \\\n   MusicSwipe/Core/Config/Supabase.plist")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(Theme.textPrimary)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .cardStyle()
            }
            .padding(24)
        }
    }
}
