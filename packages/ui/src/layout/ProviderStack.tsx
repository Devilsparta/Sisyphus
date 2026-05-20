import type { ReactNode } from 'react';
import { getProviders } from '@sisyphus/kernel/ui';

/**
 * Nests every plugin-contributed provider around `children`, outermost first
 * by registration order.
 *
 * Snapshots the provider list at render time. M4 host registers all providers
 * synchronously before App renders, so this is fine. If a future milestone
 * starts adding providers after mount, swap this for an effect-based store
 * with subscription.
 */
export default function ProviderStack({
  children,
}: {
  children: ReactNode;
}) {
  const providers = getProviders();
  const nested = providers.reduceRight<ReactNode>(
    (acc, Provider) => <Provider>{acc}</Provider>,
    children,
  );
  return <>{nested}</>;
}
