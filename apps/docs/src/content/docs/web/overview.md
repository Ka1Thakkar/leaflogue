---
title: Use Leaflogue in a browser
description: Open your library from any browser, with the same books, passages, and notes as your computers.
---

The web app is Leaflogue in a browser. It shows the same library your
computers sync: read and edit passages and notes, organise books and
threads, see the day's highlight and your statistics, ask the AI about a
passage, and import from your e-reader. A change made in the browser reaches
your computers the next time they sync.

It is optional, and like sync it runs on something **you** host. There is no
Leaflogue server and no Leaflogue account.

## Choose how to host it

| | [With PostgreSQL](/web/postgresql/) | [With Convex](/web/convex/) |
| --- | --- | --- |
| You run | One container (or a small Node service) beside your database | Static files on any web host, plus your Convex deployment |
| Good for | People who sync through PostgreSQL | People who sync through Convex |

Use the same one your computers sync with, so all of them share one library.

## What looks the same

The web app is the desktop app's own interface, so everything you know from
your computer is where you expect it: the icons down the left (and the
sidebar you can expand with <kbd>⌘</kbd> <kbd>B</kbd>, or <kbd>Ctrl</kbd>
<kbd>B</kbd>), the library overview, book pages, Highlights, Threads, and
Statistics.

- **Search and commands.** Press <kbd>⌘</kbd> <kbd>K</kbd> (<kbd>Ctrl</kbd>
  <kbd>K</kbd>) or click the search bar at the top to find books, passages,
  notes, tags, threads, pages, and settings, and to run actions such as adding
  a book, importing a file, switching theme, or signing out. Only what works
  in a browser is offered. See [getting around](/start/navigation/).
- **Customise.** Arrange the library and Statistics pages, including
  On this day, Currently reading, Pick back up, Recently kept, and Time of
  day, and place widgets below your books. Your layout is kept with your
  account, so it is the same in every browser you sign in from. It is separate
  from the layout on your computers.
- **Themes.** All the built-in themes, light and dark. The choice is kept in
  this browser.

## What is different

At the top right, instead of the sync status you see **Saved online**: every
change is saved to your library as you make it, so there is nothing to sync.
Point at it to see who you are signed in as. **Settings** has three sections:
Appearance, **Account** (signed-in email and **Sign out**; on Convex, also
which deployment holds your library and **Use a different deployment**), and
Optional AI.

A browser cannot reach files and devices on your computer, so these stay in
the desktop app:

| In the desktop app only | In the browser instead |
| --- | --- |
| Choosing a folder, or a plugged-in e-reader, to import from | Choose the file itself, such as `KoboReader.sqlite` or `My Clippings.txt`. For KOReader or Boox, choose all their files at once. |
| [Local EPUB reader](/library/epub/) and [Calibre library links](/library/calibre/) (0.1.1) | Read linked files in the desktop app; saved library highlights and notes remain available in the browser. |
| Backups and restores | Your library lives on your server or deployment; back that up. |
| Exporting to Markdown or JSON | Export from the desktop app. |
| Checking for and installing updates | Whoever hosts it updates the web app. |
| The themes folder, and importing or exporting theme files | Choose any built-in theme. |
| [Custom widgets](/widgets/custom-widgets/) and [widget recipes](/widgets/plugins/) | Arrange Leaflogue's own widgets. |
| [Offline English dictionary](/library/dictionary/) | Use Leaflogue desktop for bundled word definitions and synonyms. |
| Your AI key in Settings | Whoever hosts it sets the key where the web app runs. |

## Who can sign in

Only the email addresses you allow. Everyone you allow can read and change
the whole library, so allow only yourself, or people you would hand your
books to. Each person's page layouts are their own.

## AI in the browser

The AI uses a provider key you set where the web app runs, never in a browser.
Without one, AI features are not offered. In **Settings**, choose which of the
available providers and models to use.
