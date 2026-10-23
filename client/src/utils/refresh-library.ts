import { useCreatorReadingStore } from '../stores/creator-reading';
import { useAppStore } from '../stores/app';
import { useFoldersStore } from '../stores/folders';
import { useFeedStore } from '../stores/feed';
import { useLikesStore } from '../stores/likes';
import { useMomentsStore } from '../stores/moments';

// Counts and representative media can change independently of the number of works.
export async function refreshLibraryAfterRemoval() {
  useCreatorReadingStore().invalidate();
  await Promise.all([
    useFoldersStore().fetchFolders(true),
    useFeedStore().loadInitial(true),
    useLikesStore().initialize(true),
    useMomentsStore().fetchMoments(true),
    useAppStore().fetchStats({ background: true }),
  ]);
}
