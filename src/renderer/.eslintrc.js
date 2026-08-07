/**
 * Renderer-scoped rule adjustments.
 *
 * Kept here rather than in the root config so it is obvious these apply to UI
 * code only, and so nothing outside `src/renderer/` is loosened.
 *
 * Both rules come from airbnb's pre-TypeScript, propTypes-era React config:
 *
 *  - `react/require-default-props` wants a `defaultProps` object for every
 *    optional prop. `defaultProps` on function components is deprecated in
 *    React 19 and is a runtime warning; TypeScript default parameter values
 *    (`{ variant = 'secondary' }`) are the supported replacement and the type
 *    system already proves the prop is optional.
 *
 *  - `react/jsx-props-no-spreading` bans `{...rest}`. A design system that
 *    wraps native elements has to forward the rest of the DOM props, otherwise
 *    every primitive would need to re-declare `onClick`, `aria-*`, `data-*`,
 *    `id`, `name`... The spread is typed by the element's own props interface,
 *    so it is not the loophole the rule assumes.
 */
module.exports = {
  rules: {
    'react/require-default-props': 'off',
    'react/jsx-props-no-spreading': 'off',
  },
};
