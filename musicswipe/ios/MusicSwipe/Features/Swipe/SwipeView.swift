import SwiftUI

struct SwipeView: View {

    @StateObject private var model = SwipeViewModel()
    @Environment(\.scenePhase) private var scenePhase

    @State private var drag: CGSize = .zero
    @State private var isCommitting = false

    private let swipeThreshold: CGFloat = 120
    private let superlikeThreshold: CGFloat = 150

    var body: some View {
        ZStack {
            BackgroundView()

            VStack(spacing: 0) {
                header

                deckArea
                    .padding(.horizontal, 20)
                    .padding(.top, 8)

                actionButtons
                    .padding(.vertical, 18)
            }
        }
        .task { await model.loadInitialDeck() }
        .onDisappear { model.stopPlayback() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { model.pausePlayback() }
        }
    }

    // MARK: - Шапка

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Лента")
                    .font(.largeTitle.weight(.bold))
                    .foregroundStyle(Theme.textPrimary)

                Text(model.cards.isEmpty ? "Подбираем треки" : "Осталось карточек: \(model.cards.count)")
                    .font(.caption)
                    .foregroundStyle(Theme.textSecondary)
            }

            Spacer()

            if model.isRefilling {
                ProgressView()
                    .tint(Theme.accent)
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
    }

    // MARK: - Колода

    @ViewBuilder
    private var deckArea: some View {
        if model.isLoading && model.cards.isEmpty {
            loadingState
        } else if let error = model.errorMessage, model.cards.isEmpty {
            VStack {
                Spacer()
                ErrorBanner(message: error) {
                    Task { await model.retry() }
                }
                Spacer()
            }
        } else if model.cards.isEmpty {
            VStack {
                Spacer()
                EmptyStateView(
                    systemImage: "sparkles",
                    title: "Карточки закончились",
                    message: "Мы подберём новую порцию по вашим последним свайпам.",
                    actionTitle: "Подобрать ещё"
                ) {
                    Task { await model.retry() }
                }
                Spacer()
            }
        } else {
            cardStack
        }
    }

    private var cardStack: some View {
        ZStack {
            ForEach(Array(model.visibleCards.enumerated()).reversed(), id: \.element.id) { index, track in
                SwipeCardView(
                    track: track,
                    isTop: index == 0,
                    dragTranslation: index == 0 ? drag : .zero,
                    player: index == 0 ? model.player : nil
                )
                .scaleEffect(1 - CGFloat(index) * 0.04, anchor: .bottom)
                .offset(y: CGFloat(index) * 12)
                .offset(index == 0 ? drag : .zero)
                .rotationEffect(.degrees(index == 0 ? Double(drag.width / 20) : 0))
                .zIndex(Double(model.visibleCards.count - index))
                .allowsHitTesting(index == 0 && !isCommitting)
                .gesture(dragGesture)
            }
        }
        .frame(maxHeight: .infinity)
    }

    private var loadingState: some View {
        VStack(spacing: 16) {
            Spacer()
            ProgressView()
                .controlSize(.large)
                .tint(Theme.accent)
            Text(model.isRefilling ? "Собираем рекомендации…" : "Загружаем ленту…")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
            Spacer()
        }
    }

    // MARK: - Кнопки

    private var actionButtons: some View {
        HStack(spacing: 26) {
            circleButton(systemImage: "xmark", color: Theme.pass, size: 60) {
                commit(.pass)
            }

            circleButton(systemImage: "star.fill", color: Theme.superlike, size: 50) {
                commit(.superlike)
            }

            circleButton(systemImage: "heart.fill", color: Theme.like, size: 60) {
                commit(.like)
            }
        }
        .disabled(model.cards.isEmpty || isCommitting)
        .opacity(model.cards.isEmpty ? 0.4 : 1)
    }

    private func circleButton(
        systemImage: String,
        color: Color,
        size: CGFloat,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: size * 0.38, weight: .bold))
                .foregroundStyle(color)
                .frame(width: size, height: size)
                .background(Theme.surface, in: Circle())
                .overlay { Circle().strokeBorder(color.opacity(0.5), lineWidth: 1.5) }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Жест

    private var dragGesture: some Gesture {
        DragGesture()
            .onChanged { value in
                guard !isCommitting else { return }
                drag = value.translation
            }
            .onEnded { value in
                guard !isCommitting else { return }

                let horizontal = value.translation.width
                let vertical = value.translation.height

                if vertical < -superlikeThreshold && abs(horizontal) < swipeThreshold {
                    commit(.superlike)
                } else if horizontal > swipeThreshold {
                    commit(.like)
                } else if horizontal < -swipeThreshold {
                    commit(.pass)
                } else {
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                        drag = .zero
                    }
                }
            }
    }

    /// Улетающая карточка + запись свайпа.
    private func commit(_ direction: SwipeDirection) {
        guard !model.cards.isEmpty, !isCommitting else { return }

        isCommitting = true
        Haptics.impact(direction == .superlike ? .heavy : .medium)

        withAnimation(.easeOut(duration: 0.28)) {
            drag = flyAwayOffset(for: direction)
        }

        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 280_000_000)

            model.swipe(direction)

            // Следующая карточка должна появиться на месте, а не «прилететь» назад.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) { drag = .zero }

            isCommitting = false
        }
    }

    private func flyAwayOffset(for direction: SwipeDirection) -> CGSize {
        switch direction {
        case .like: return CGSize(width: 620, height: -60)
        case .pass: return CGSize(width: -620, height: -60)
        case .superlike: return CGSize(width: 0, height: -900)
        }
    }
}
