import SwiftUI
import UIKit

struct MainTabView: View {

    @State private var selection: Tab = .discover

    enum Tab: Hashable {
        case discover, likes, profile
    }

    init() {
        // Системная подложка таббара светлее фона приложения — заменяем её.
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(Theme.background)
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }

    var body: some View {
        TabView(selection: $selection) {
            SwipeView()
                .tag(Tab.discover)
                .tabItem { Label("Лента", systemImage: "flame.fill") }

            LikesView()
                .tag(Tab.likes)
                .tabItem { Label("Любимое", systemImage: "heart.fill") }

            ProfileView()
                .tag(Tab.profile)
                .tabItem { Label("Профиль", systemImage: "person.fill") }
        }
    }
}
