---
title: Custom widgets
description: Build your own widgets for the library and Statistics pages, then edit, share, and import them.
---

Leaflogue's overview widgets answer the questions most readers ask. When you
have your own question, such as "how many passages have I tagged favourite?"
or "which months do I write the most notes in?", build a widget for it.

:::note
Custom widgets are part of the desktop app. The [web app](/web/overview/)
shows Leaflogue's own widgets, all of which you can still arrange.
:::

A custom widget is a short recipe: what to count, how to group it, which
passages or books to include, and which chart to draw. It never contains code,
so a widget someone shares with you can only ever count your library and draw
a chart.

## Build a widget

1. On the library page or the Statistics page, choose **Customise**.
2. Choose **New widget** at the start of the list of widgets to add.
3. Fill in the builder. Every choice is a dropdown, and the preview on the
   right shows the widget with your own library as you go.
4. Choose **Add widget**. It goes onto the page, where you can move and resize
   it like any other widget. Choose **Done** to keep the page as it is.

The builder asks for:

| Choice | What it does |
| --- | --- |
| **Title** | The name shown at the top of the widget. |
| **Count** | Passages, books on your shelf, or notes. |
| **Show as** | A number, columns, a ranked list, a calendar of days, or a list of the passages, books, or notes themselves. |
| **Group by** | For columns and ranked lists: what each column or row stands for, such as weekday, tag, or author. |
| **Order** | Largest first, or in their own order (hours from midnight, weekdays from Monday, years from oldest, names from A). |
| **How many** | How many columns, rows, or items to show. |
| **Only** | Filters. Add one to count only some things, for example passages whose tag is *favourite*, or books whose status is *unread*. Choose **is not** to leave things out instead. A widget can have up to six filters, and something is counted only when it matches all of them. |
| **Description** | Optional. A line shown when you add the widget, and to anyone you share it with. |

## What you can count and group by

Passages can be grouped and filtered by any of these. Notes can use the
length, time, and book choices. Books can use the book choices.

| Choice | Means |
| --- | --- |
| **Length** | Up to 100 characters, 101–300, 301–600, or over 600. |
| **Hour of the day** | When you highlighted it. Only e-readers that record the time count here; the widget says how many passages had one. |
| **Weekday**, **Month**, **Year** | When you highlighted it, or when it was added if your reader didn't say. Year filters can say *this year* or *last year*, so a widget stays current. |
| **Has a note** | Whether you wrote a note on the passage. |
| **Tag**, **Thread** | The passage's tags and threads. A passage with two tags counts once under each. |
| **Book**, **Author**, **Series**, **Publisher**, **Language** | Details of the book the passage is from, as your reader recorded them or as you edited them. |
| **Reading status** | Unread, reading, finished, or paused. |
| **Year finished** | For finished books with a finish date. |

Names such as tags and authors match whatever their capitals: a filter for
*favourite* finds your *Favourite* tag too.

## Edit or delete a widget

While customising, each custom widget has three extra buttons in its toolbar:

- **Edit** (the pencil) reopens the builder. Changes apply wherever the widget
  is placed.
- **Export** (the arrow) saves the widget as a file. See below.
- **Delete** (the bin) removes the widget from both pages and from the list of
  widgets to add. Export it first if you might want it back.

**×** only takes a widget off the current page; it stays in the list of
widgets to add, ready to put back.

## Share a widget

Choose **Export** on a custom widget and pick where to save it. You get a small
file ending in `.leaflogue-widget.json` that you can send to a friend, keep
with your notes, or [offer on the Plugins page](/widgets/plugins/).

To use a widget file, choose **Customise**, then **Import widgets**, and pick
one or more files. Each widget joins the list of widgets to add, and you choose
where it goes. Leaflogue checks every file before adding anything: a file that
isn't a widget, is larger than 16 KB, or asks for something Leaflogue doesn't
understand is turned down with a reason, and nothing is added. A widget you
already have is skipped.

A shared widget counts *your* library. If it filters by a tag or thread you
don't have, it shows that nothing matches yet; edit it to pick one of yours.

## Where widgets are kept

Your widgets are saved in the [settings file](/start/files-and-settings/)
under `widgets`, beside your page layouts. You can keep up to 24.
