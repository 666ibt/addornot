import SwiftUI
import UIKit

struct AuthView: View {

    @EnvironmentObject private var client: SupabaseClient
    @StateObject private var model = AuthViewModel()
    @FocusState private var focusedField: Field?

    private enum Field { case email, password }

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                header

                VStack(spacing: 14) {
                    field(
                        title: "Почта",
                        text: $model.email,
                        systemImage: "envelope.fill",
                        keyboard: .emailAddress,
                        focus: .email
                    )

                    field(
                        title: "Пароль",
                        text: $model.password,
                        systemImage: "lock.fill",
                        isSecure: true,
                        focus: .password
                    )
                }

                if let error = model.errorMessage {
                    ErrorBanner(message: error)
                }

                VStack(spacing: 12) {
                    PrimaryButton(
                        title: model.mode.primaryTitle,
                        systemImage: "arrow.right",
                        isLoading: model.isBusy,
                        isEnabled: model.canSubmit
                    ) {
                        focusedField = nil
                        Task { await model.submit() }
                    }

                    Button(model.mode.switchTitle) {
                        model.toggleMode()
                    }
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                }

                divider

                Button {
                    Task { await model.continueAsGuest() }
                } label: {
                    Label("Продолжить без регистрации", systemImage: "person.crop.circle.dashed")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .foregroundStyle(Theme.textPrimary)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .disabled(model.isBusy)

                Text("Гостевой вход создаёт временный аккаунт: лайки и вкусовой профиль "
                     + "сохраняются, но восстановить их на другом устройстве не получится.")
                    .font(.caption)
                    .foregroundStyle(Theme.textTertiary)
                    .multilineTextAlignment(.center)
            }
            .padding(24)
            .padding(.top, 40)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var header: some View {
        VStack(spacing: 12) {
            Image(systemName: "flame.fill")
                .font(.system(size: 52))
                .foregroundStyle(Theme.brandGradient)

            Text("MusicSwipe")
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(Theme.textPrimary)

            Text("Пришлите ссылку на свой плейлист — и свайпайте треки,\nкоторые вам подойдут")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
        }
    }

    private var divider: some View {
        HStack(spacing: 12) {
            Rectangle().fill(Color.white.opacity(0.12)).frame(height: 1)
            Text("или").font(.caption).foregroundStyle(Theme.textTertiary)
            Rectangle().fill(Color.white.opacity(0.12)).frame(height: 1)
        }
    }

    @ViewBuilder
    private func field(
        title: String,
        text: Binding<String>,
        systemImage: String,
        keyboard: UIKeyboardType = .default,
        isSecure: Bool = false,
        focus: Field
    ) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(Theme.textTertiary)
                .frame(width: 20)

            Group {
                if isSecure {
                    SecureField(title, text: text)
                } else {
                    TextField(title, text: text)
                        .keyboardType(keyboard)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .foregroundStyle(Theme.textPrimary)
            .focused($focusedField, equals: focus)
        }
        .padding(.horizontal, 16)
        .frame(height: 54)
        .cardStyle(cornerRadius: 16)
    }
}

@MainActor
final class AuthViewModel: ObservableObject {

    enum Mode {
        case signIn, signUp

        var primaryTitle: String { self == .signIn ? "Войти" : "Создать аккаунт" }
        var switchTitle: String {
            self == .signIn ? "Нет аккаунта? Зарегистрироваться" : "Уже есть аккаунт? Войти"
        }
    }

    @Published var email = ""
    @Published var password = ""
    @Published private(set) var mode: Mode = .signIn
    @Published private(set) var isBusy = false
    @Published private(set) var errorMessage: String?

    private let client = SupabaseClient.shared

    var canSubmit: Bool {
        email.contains("@") && password.count >= 6 && !isBusy
    }

    func toggleMode() {
        mode = mode == .signIn ? .signUp : .signIn
        errorMessage = nil
    }

    func submit() async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }

        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)

        do {
            switch mode {
            case .signIn:
                try await client.signIn(email: address, password: password)
            case .signUp:
                try await client.signUp(email: address, password: password)
            }
        } catch {
            errorMessage = (error as? SupabaseError)?.errorDescription ?? error.localizedDescription
        }
    }

    func continueAsGuest() async {
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }

        do {
            try await client.signInAnonymously()
        } catch {
            errorMessage = (error as? SupabaseError)?.errorDescription ?? error.localizedDescription
        }
    }
}
