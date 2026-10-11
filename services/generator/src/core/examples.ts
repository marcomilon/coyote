/**
 * The landing page's example sites (PLAN.md "Landing examples"). They are the only pages served publicly before
 * the publishing plan: repo `examples/sites/<slug>/` is deployed to the sites bucket's `_examples/<slug>/` and
 * served at urls.exampleUrl(slug). Their slugs are reserved so no owner can claim them.
 */
export const EXAMPLE_SITES = ['taller-ruiz', 'panaderia-rosa', 'salon-luna'] as const;
