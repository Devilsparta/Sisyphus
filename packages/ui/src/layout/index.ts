export { default as PanelLayout } from './PanelLayout';
export { default as ProviderStack } from './ProviderStack';
// View registry now lives in @sisyphus/kernel/ui so plugins can register
// without depending on the ui package (which would create a cycle).
export {
  registerView,
  getView,
  listViews,
  type UIViewEntry,
} from '@sisyphus/kernel/ui';
