import Foundation

enum SupabaseError: LocalizedError {
    case notConfigured
    case notAuthenticated
    case api(status: Int, message: String, code: String?)
    case transport(Error)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Приложение не настроено: добавьте Supabase.plist с адресом проекта и anon-ключом."
        case .notAuthenticated:
            return "Нужно войти в приложение."
        case .api(_, let message, _):
            return message
        case .transport(let error):
            return "Нет связи с сервером: \(error.localizedDescription)"
        case .decoding:
            return "Сервер вернул неожиданный ответ."
        }
    }

    /// Код ошибки от Edge Function — по нему экраны решают, что показать.
    var code: String? {
        if case .api(_, _, let code) = self { return code }
        return nil
    }

    var isUnauthorized: Bool {
        if case .api(let status, _, _) = self { return status == 401 }
        if case .notAuthenticated = self { return true }
        return false
    }
}
