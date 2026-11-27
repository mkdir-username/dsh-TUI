/**
 * Re-export of the `@mkdir-username/dsh-handoff-control` plugin under this
 * package's own name, so the bundle patch layer can mount the handoff row as
 * `@deepseek-harness-tui/dsh-tui/handoff-control` instead of the bare package name.
 *
 * Same resolution constraint as `./working-activity`: the dsh Loader resolves
 * row names from the *profile* directory, and pnpm links only the profile's
 * direct dependencies there — a bare name for this package would die with
 * ERR_MODULE_NOT_FOUND at boot and dispose the whole app. Mounting through
 * this subpath anchors resolution at @deepseek-harness-tui/dsh-tui itself.
 *
 * The row ships with `mode: off`: the controller spends tokens and holds the
 * turn open while it judges, so enabling it stays a deliberate user choice.
 * @module @deepseek-harness-tui/dsh-tui/handoff-control
 */
export * from '@mkdir-username/dsh-handoff-control'
