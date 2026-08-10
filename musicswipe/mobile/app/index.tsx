import { Background, Loader } from '../components/ui';

/**
 * Стартовый экран. Ничего не решает сам — редирект приходит из корневого
 * layout, как только станет понятно, вошёл ли пользователь и есть ли
 * у него разобранный плейлист.
 */
export default function Index() {
  return (
    <Background>
      <Loader />
    </Background>
  );
}
