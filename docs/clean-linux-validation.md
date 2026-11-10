# Clean Linux release validation

Use this procedure before calling a Leaflogue Linux artifact supported. Run it
on a newly installed, non-development machine for each architecture; do not
reuse a build directory, application profile, or local library.

## Arm64 runtime gate

The CI workflow validates artifact structure for both `x64` and `arm64`, and
launches the x64 payload. A maintainer must perform the following procedure on
a clean `aarch64`/`arm64` Linux installation before the arm64 runtime gate can
be checked.

1. Record the distribution release, kernel, desktop session, and output of
   `uname -m`. It must report `aarch64` or `arm64`.
2. Download the arm64 AppImage, tarball, and `SHA256SUMS-arm64.txt` from one
   release candidate. Keep the files in an otherwise empty directory.
3. Verify the exact downloaded files before running either artifact:

   ```sh
   sha256sum --check SHA256SUMS-arm64.txt
   ```

4. Make the AppImage executable and launch it with a fresh XDG profile:

   ```sh
   chmod +x Leaflogue-*-arm64.AppImage
   mkdir -p validation-home/config validation-home/data
   HOME="$PWD/validation-home" \
   XDG_CONFIG_HOME="$PWD/validation-home/config" \
   XDG_DATA_HOME="$PWD/validation-home/data" \
   ./Leaflogue-*-arm64.AppImage
   ```

   If the system needs a FUSE compatibility package for AppImage mounting,
   install the distribution-provided package and record that dependency. Do not
   bypass checksum verification or use `--no-sandbox` for a normal-user test.

5. Confirm that the app opens with no account or network configuration. Create
   a library, import only synthetic fixtures, add and edit one highlight and
   one note, create a backup, then restore that backup. Close the app and
   relaunch it using the same isolated profile to confirm the library survives.
6. Extract and launch the tarball with a second isolated profile. Confirm the
   same basic offline workflow, then remove that profile and extracted folder.

   ```sh
   mkdir tar-validation
   tar -xzf Leaflogue-*-arm64.tar.gz --directory tar-validation
   find tar-validation -type f -name leaflogue -perm /111 -print
   ```

7. Record the artifact filenames and SHA-256 values, OS details, pass/fail
   result for both formats, any required host packages, and failures without
   including a personal library, credentials, screenshots of reading data, or
   configuration contents. Attach the record to the release candidate.

## x64 desktop gate

Repeat the procedure above on a clean x64 Linux desktop, using the x86_64
AppImage and x64 tarball and checksum manifest. Record the actual session and
artifact results. CI launches an extracted x64 payload with `--no-sandbox` in
an isolated runner; that is automation evidence, not normal-user desktop
acceptance. Previous workflow runs do not validate the current candidate.

## Orca and keyboard gate

Use the candidate on a full Linux desktop with Orca enabled. A freshly
installed desktop VM is useful for a manual pass; record that it is a VM and
the guest architecture. A container/Xvfb run is not this pass. Record the Orca
version, desktop/session, architecture, artifact checksum, tester, and date.

### Start Orca (Ubuntu / GNOME)

1. In the Linux guest, enable **Settings → Accessibility → Screen Reader**, or
   press **Super + Alt + S**. On an Apple keyboard, Super is normally Command;
   the VM may need its keyboard-capture option to send the shortcut to Linux.
2. If Orca is not installed on Ubuntu, run `sudo apt install orca`. Start its
   preferences with `orca --setup` and choose the laptop keyboard layout when
   there is no numeric keypad. In that layout, Caps Lock is the Orca modifier;
   **Caps Lock + Space** opens preferences and **Caps Lock + H** starts help.
3. Verify that speech works in a built-in application before opening Leaflogue.
   Launch the candidate normally, as a regular user, without `--no-sandbox`.
4. Put the mouse aside. Use Tab/Shift+Tab to move focus, arrows in lists,
   Enter/Space to activate, and Escape to close dialogs. Listen for the
   control's name, role, state, and any errors. An unlabeled button, silent
   result, or trapped focus is a finding, even if it looks correct on screen.

Official instructions: [GNOME Orca](https://gnome.pages.gitlab.gnome.org/orca/help/introduction.html)
and [Ubuntu's walkthrough](https://ubuntu.com/desktop/docs/en/latest/tutorial/get-started-with-the-screen-reader/).

### Walk through Leaflogue

1. Navigate the sidebar, library, book details, and settings with the keyboard.
   Confirm visible focus and that Orca announces each control's name, role,
   and current state. Check headings and reading order.
2. Import a synthetic library, open a book, add and edit a passage and note,
   and navigate search results. Confirm labels and validation errors are
   announced and dialogs return focus to the control that opened them.
3. Open the AI explanation panel without sending a request. Check its title,
   disclosure, provider controls, close button, and keyboard focus behavior.
4. Create and restore a backup. Check file chooser access, confirmation
   announcements, cancellation, and focus after completion.
5. Repeat key navigation with the compact layout and light/dark themes.
   Record inaccessible controls, focus traps, missing announcements, or
   clipped focus indicators with reproduction steps. Leave the gate open
   until release-blocking problems have been fixed and rechecked.

Attach the completed record to the candidate. An automated accessibility
scan or an Xvfb launch cannot substitute for this screen-reader pass.
