import Foundation

/// Настройки подключения к Supabase.
struct SupabaseConfig: Sendable {
    let url: URL
    let anonKey: String

    var restURL: URL { url.appendingPathComponent("rest/v1") }
    var authURL: URL { url.appendingPathComponent("auth/v1") }
    var functionsURL: URL { url.appendingPathComponent("functions/v1") }
}

/// Конфигурация приложения.
///
/// Ключи лежат в `Supabase.plist`, который не попадает в git — рядом есть
/// `Supabase.example.plist` с образцом. Если файла нет, приложение не падает,
/// а показывает экран с инструкцией: так проект можно склонировать и запустить,
/// не гадая, почему белый экран.
enum AppConfig {

    static let supabase: SupabaseConfig? = loadSupabaseConfig()

    /// Сколько карточек должно остаться в колоде, чтобы начать подгрузку.
    static let deckRefillThreshold = 5

    /// Размер запрашиваемой пачки рекомендаций.
    static let deckPageSize = 20

    private static func loadSupabaseConfig() -> SupabaseConfig? {
        guard
            let path = Bundle.main.path(forResource: "Supabase", ofType: "plist"),
            let values = NSDictionary(contentsOfFile: path) as? [String: Any]
        else {
            return nil
        }

        guard
            let rawURL = (values["SUPABASE_URL"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
            let anonKey = (values["SUPABASE_ANON_KEY"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
            !rawURL.isEmpty, !anonKey.isEmpty,
            !rawURL.contains("ВАШ_"), !anonKey.contains("ВАШ_"),
            let url = URL(string: rawURL)
        else {
            return nil
        }

        return SupabaseConfig(url: url, anonKey: anonKey)
    }
}
