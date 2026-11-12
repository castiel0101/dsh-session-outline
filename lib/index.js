/**
 * dsh-session-outline — Host half (Cordis plugin).
 *
 * The feature is entirely in the browser: the client half registers a Session
 * header button that opens a right-side drawer listing every turn of the
 * current Session, read from the host's existing `turnOutline` projection and
 * jumped to through the Chat view's own anchor rows. Nothing on this side holds
 * state, talks to a network, or writes a file, so this entry exists only to put
 * the package on the plugin roster (client-modules scans active Loader entries
 * for `dsh.client` declarations, so the row must activate for the bundle to be
 * served).
 *
 * @module dsh-session-outline
 */

/** Loader row name; must match the package name in `cordis.patch.yml`. */
export const name = 'session-outline'

/** No service is required: the row activates immediately. */
export const inject = []

/**
 * Mount the plugin.
 * @returns {void}
 */
export function apply() {
  // Intentionally empty: the browser half owns the whole feature.
}
