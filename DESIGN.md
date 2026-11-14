# Nafyn Design Guidelines

# Views and pages

> Note: View are used in SwiftUI, for the Nafyn iOS app. Pages are used on any web browser, on any device, for the Nafyn web service. Do not use "page" or "view" whatever happens to talk about a Nafyn screen.

By default, the background color used is `#2a2a27ff` and the text color is `#ffffffae`, using RGBA.

Content never touches the edges of the screen. On small screens, every page keeps a small horizontal margin (at least 16px) on both sides, so that content stays away from the edges of the display it is used from. No page is edge-to-edge.

On the web, no element may go out of the width of the viewport (`100vw`), whatever the page or the device. Users can never scroll horizontally, except in a container that is made for it (like a row of navigation buttons), which scrolls inside of its own frame without moving the page.

On the web, no element may be hidden behind the header: the first element of a page starts below the header, and its gradient.

> *See "Responsiveness" for more information about adapting elements to the screen size*

## Header and Sidebar (web)

Exclusively on the web, there are the header, and the sidebar. The header shows the Nafyn wordmark as well as a search field. The sidebar shows all primary navigation links.

On small screens, the Nafyn wordmark is tappable to open the sidebar.

The Nafyn wordmark never disappears from the header, on any device. Except when the search button, it will hide the **wordmark only**.

All buttons in the sidebar are always white, whatever the background behind them (including a page colored with a cover art's primary color), as well as the search field in the header.

---

The header and sidebar use a beautiful smooth/soft gradient (different from a linear gradient) from black to transparent (from the outer-edge to the viewport)

## Library

The library does not have the same data as the catalog, the library only includes the tracks and albums that have been successfully downloaded. Most of the times, the library is either shown as a grid or as a list.

On the web, on small devices, there is a dedicated "Library" web page ([`/library`](https://github.com/lumaa-dev/Nafyn/blob/main/app/pages/library.vue)). It also works on bigger screen, but was primarily made for mobile devices that do not use the iOS app. On iOS, there is a dedicated "Library" tab ([`LibraryView`](https://github.com/lumaa-dev/NafynApp/blob/main/Nafyn/Views/Tabs/LibraryView.swift)). Both the "Library" web page and "Library" tab view use the similar layout:

1. Pinned elements in a 3-column grid, with the "Pinned" header
2. Navigation buttons, that go into the users' library tracks, library albums, and the users' playlists (on the iOS, there is also the "My Year" button)
3. Recently played media content, in a 2-column grid, with the "Recently Played" header. The media content can be a library track, a library album, or a playlist

On the web, the pinned grid is responsive. On small screens, pinned elements are displayed using the [`MediaBox`](https://github.com/lumaa-dev/Nafyn/blob/main/app/components/MediaBox.vue) component, instead of a compact version of it.

On the web, on bigger devices, the dedicated library tab cannot be reached without manually manipulating the URL address.

---

On the web and on iOS, there are specific pages/views to display the users' library tracks, library albums and playlists.

- For library tracks: Displayed as a list
- For library albums and playlists: Displayed as a grid, which has 2 columns on small screens

These specific views feature a search bar to search for the chosen library element. And also, users can sort their library elements using different sorting algorithms.

There is always a margin between the header of these pages/views (title, search bar and sorting) and the list or grid below it.

Users can also select multiple library elements by toggling the "Select" button, in the toolbar for iOS, on the bottom right corner for the web. The "Select" button, when toggled on, allows users to make bulk actions on multiple elements at once (Example: "Add to playlist", "Delete", "Edit metadata") through a *context menu* or an "Actions" button.

When multiple track rows are being selected, rows do not show a check box. A selected row is shown with a highlight and an outline instead, so that the selection is not shown by color alone.

> *See "Context Menus" for information about utilizing context menus in Nafyn*.\
> *See "Toolbars" for more information about toolbar designs*

## Search

Search shows its results as one single list, whatever their kind. Each result is a row, and a row is either a track row, an album row or an artist row (an artist row shows a round picture, a track or album row a square cover). The kind of the row is always written out in its secondary line ("Track · Artist · Album", "Album · Artist", "Artist"), it is never told by the shape of the cover alone.

The list is ordered by likelihood: the most up-top result is the most likely answer to the query, the most down-bottom result is the least likely one. All kinds are ranked together, on the same scale, so a track can be above an album and an artist can be between two tracks. When a query is equally likely an artist, an album and a track, the artist comes first, then the album, then the track. There are no categories, headers or separate sections between results.

When the most likely result is an album, that album is followed by its tracks, in the album's order, before any other result.

The search filters (albums only, tracks only, artists only) are kept: with a filter on, the list only holds that kind of rows, in the same order.

A search result never is a "Deluxe" or "Remaster" edition, a "Live" or "Remix" work or version, unless the query itself says so. A track is the exception for "Deluxe": a track that is on a Deluxe album is found, and shown on the standard album when it is on both.

## Artist

The artist page/view starts with the artist's picture and name, the number of listeners and the biography, followed by the artist's `release`s sorted by kind, each kind being a *category grid* (see "Category grids"). The categories are, in this order, and only the ones that hold something are shown:

1. Albums
2. EPs
3. Singles
4. Compilations
5. Live
6. Remixes
7. Soundtracks
8. Other

A live album is in "Live", never in "Albums", whatever its primary type; the same goes for compilations, remixes and soundtracks.

In a category, `release`s are ordered by release-date, the newest first (the ones without a date last). A standard edition always comes before its edition of the same day.

The "Deluxe" or "Remaster" edition of an album or EP that has a standard edition is always shown next to it, as a `release` of its own, even when MusicBrainz holds it inside the standard edition's release-group (like "Pinkerton" by Weezer). Opening it opens the album on that very release. "Live" editions are never added this way, they are in "Live" already.

## Category grids

A category grid is a titled group of `release`s (an artist's "Albums", the releases of an album...), shown with [`MediaBox`](https://github.com/lumaa-dev/Nafyn/blob/main/app/components/MediaBox.vue) on the web, and `MusicCard` on iOS:

- On the web, on widescreens, the grid has 2 rows, and scrolls horizontally
- On iOS, **and** on small screens on the web, the grid has 1 row, and scrolls horizontally

The grid scrolls inside of its own frame, the page/view itself never scrolls horizontally. A `release` in a grid shows its cover art, its title, and a description under the title (the artist, or the disambiguation of a release when there is one).

`release`s in a grid are ordered by release-date. The grid's frame reaches the edge of the content, so covers scroll under the edge, but the first cover never touches the edge of the screen (see "Views and pages").

## Track/Album Detail view

Track or album detail views (and also Library track/album detail views) show what the name implies: Details of the chosen track or album the user has clicked or tapped on.

Detail views are colored with the cover art's primary color, therefore the label's color is adapted between white and black (depending on the cover art's primary color). Also, on iOS only, the cover art is expanded above the app's safe area using [`backgroundExtensionEffect`](https://developer.apple.com/documentation/swiftui/view/backgroundextensioneffect()) and [`safeAreaInset`](https://developer.apple.com/documentation/swiftui/view/safeareainset(edge:alignment:spacing:content:)-6gwby).

Detail views always conform to the WCAG AAA contrast (see "Contrast"): every label, symbol, link and button is checked against the cover art's primary color behind it, not only against the default background color.

At the bottom of an album detail page/view, after the track list and its footer (date, label, link to MusicBrainz), users can change which `release` of the album's `release-group` they are viewing (the standard edition, a Deluxe edition, another country, a reissue...). The releases are shown in a *category grid* (see "Category grids"), titled "Releases"; the description of each is its disambiguation when it has one, else its year and country. The release being viewed is outlined (not only colored). Choosing another release shows its track list, label and cover art in place, without leaving the page/view. When the viewed release is not the standard one, the album as a whole cannot be requested (a request downloads the standard edition), but each of its tracks still can.

Album detail views show the track number on each track, unless it doesn't have one. Track rows in an album detail view never show the cover art: the cover art is already the album's, and showing it next to the track number clutters the row.

On iOS, detail views always have a [`ToolbarOverflowMenu`](https://developer.apple.com/documentation/swiftui/toolbaroverflowmenu) containing the same actions that were linked to the track/album row (or even [`MusicCard`](https://github.com/lumaa-dev/NafynApp/blob/main/Nafyn/Components/MusicCard.swift)) unless it creates recursion (like a navigation recursion).

Also on iOS, if the user is using the "System" theme (which removes most of Nafyn's unique designs), it should change all buttons using a `Color.blue` background, to `Color.white` or `Color.black` (with `Color.white` foreground) depending on the contrast (See "Contrast").

> *See "Toolbars" for more information about toolbar designs*\
> *See "Contrast" for more information about making Nafyn accessible, whatever the colors used*

## Cover art editing

Editing the cover art of a track (from "Edit metadata") offers the cover arts of every release its MusicBrainz `recording` is on (the single, the album, a compilation...). Editing several tracks at once, or an album, offers the cover arts of the album's `release-group` and of its releases. Only cover arts that exist are offered: a `release`, `release-group` or `recording` without a cover art is never listed, and the list says so when none is left. The user can always upload their own cover art instead.

## Now Playing

The Now Playing page/view shows the user all the necessary elements on the currently playing music, with a few widgets called "Panels". It is colorful, reusing the colors of the currently playing song's cover art to create a moving mesh gradient, while adapting the text color between white and black for constrat.

The Now Playing page/view should never be scrollable (except for the contents of panels), whatever the screen size, and on any scroll axis (top/down or left/right). The page/view itself must never be taller or wider than the screen.

The text color is only picked from the contrast with the mesh gradient (white or black), never from the device's appearance. On iOS, the "System" theme, in light mode (`ColorScheme.light`) as well as in dark mode, must never show black text on a dark background, or white text on a light one.

On large horizontal screens, whatever the support (iOS or web), there's a maximum of 2 panels, that each take up at most 50% of the available space. The 50% is a maximum, not a size: the width of a panel can vary per panel (the song info panel is usually narrower than the lyrics panel or the queue panel), depending on what it contains. 

On smaller screens, or large vertical screens, the panels are vertically aligned, and the left panel becomes the top one, and the right one replaces the left (top on smaller screens) panel with toggleable panels (rather than tab system on large screens)

The left panel cannot be changed or modified, and shows the primary song information:

- Song cover art
- Song name and artist
- Current playback
- Playback controls (Back, play/pause, forward)
- Volume slider

The right panel has currently two tabs (toggles on smaller screens), but more can be added in the future:

- Lyrics
- Queue (default active panel)

Both of these panels are explained below in *Lyrics Panel* and *Queue Panel* respectively.

All panels' top and bottom edges have a small smooth gradient, without obstructing the content of the panel. This allows for the lyrics panel and the queue panel to not have rough edges when scrolling.

---

On iOS, layout is slightly different:

- In portrait mode, or specifically when the iPhone Duo is either folded (in portrait) or unfolded (in portrait), it displays only one panel at a time (song info, lyrics, queue). Music controls are not part of any panel, they're attached at the very bottom of the Now Playing view. The cover art, on the song info panel, is enlarge to take as much horizontal space as possible, without obstructing the mesh gradient background
- In landscape mode, or specifically when the iPhone Duo is unfolded (in landscape), it allows 2 panels to be displayed at once. Just like the web layout, the song info panel is on the left half of the screen, with the music controls at the bottom of the panel. On the right half of the screen, is either the lyrics panel or the queue panel, with the queue panel being the default

The music controls are compact to allow space for other panels.

### Lyrics Panel

The Lyrics Panel has 5 different states:

- Loading - The HTTP request fetching the lyrics is still ongoing
- Error / Lyrics not found - The HTTP request did not return code `200`. A user-friendly error message is displayed when the error code is `404`.
- Static lyrics - Lyrics were found, and do not synchronize with the user's playback time
- Paragraph synced lyrics - Lyrics were found, and synchronize paragraph-per-paragraph with the user's playback time (using `LRC` for **example**)
- Syllable synced lyrics - Lyrics were found, and synchronize syllable-by-syllable with the user's playback time (using `TTML` for **example**)

Whenever lyrics are found, the lyrics are inside of a scroll view, that automatically scrolls to the newly active lyrics depending on the playback time.

Whenever synchronized lyrics are available, users can click/tap on a lyric, to automatically jump the playback to the lyric's start time. Additionally, only on iOS, users can tap-and-hold on a lyric paragraph, to open the "Share lyrics" sheet.

Optionally, users can toggle on or off in Nafyn's settings to switch the font from Instruments Serif to `sans-serif`.

> *See "Error messages" for more information about displaying errors to users*
> *See "Interface" for more information about fonts*

On iOS, users have additional Liquid Glass controls on the bottom leading edge of the scroll view:

- Translate: Translates the lyrics using the on-device [Foundation Models API](https://developer.apple.com/documentation/foundationmodels), from any language to the app's selected locale.
- Romanize: Romanizes lyrics that aren't using latin letters (A-Z) in 90% of all lyrics, using the on-device [Foundation Models API](https://developer.apple.com/documentation/foundationmodels). It does not translates from one language to another, it shows a romanized version (simplified).

These iOS-only controls require the scroll view to have a content margin at the top and bottom, and also for visual comfort reasons.

### Queue Panel

The Queue Panel is a scroll view, with 3 categories in that specific order:

1. Song history (capped to 50 songs), from oldest (at the top) to latest (at the bottom of the section)
2. Queue actions: Repeat button and shuffle button
3. Song queue, from index `0` to last index (index `0` here is the next playing song)

By default, the Queue Panel's scroll view starts at the 2nd section ("Queue actions"), therefore, when the user scroll up, it shows them their Song history (section 1). Whilst if users go down from the 2nd section, it shows them their Song queue (section 3).

The Song queue must never show the currently playing song in the queue, or any previously playing song (that's for the Song history). The Song history also must never show the currently playing song in the history, or any song that's up next in the queue (unless they've been played previously).

Repeating a track (using "Repeat One") adds the track only **once** in the history, without duplicating it after each replay.

## "Your Music Year"

"Your Music Year" is the name for the statistics feature (inspired by Spotify Wrapped, Apple Music Replay...), where users can get a weekly, monthly, yearly recap of what they've listened to on Nafyn.

# Interface

The User Interface (UI) in Nafyn is unique and privileges human creation, through artists' cover arts and playlists. It is made to be colorful, with 2 primary fonts :

- [Instrument Serif](https://fonts.google.com/specimen/Instrument+Serif?preview.script=Latn) used for titles, headers, the wordmark, primary text elements…
- The default browser `sans-serif` font, used for secondary text elements

There is also a secondary font available in the app's settings for dyslexic people: [OpenDyslexic](https://opendyslexic.org/).

Information about user interactions between Nafyn, its interface, and the reaction provided back to the user. From a keyboard push, mouse click, screen tapping, to a context menu being displayed, a new web page showed, a button state changing, etc...

Nafyn shall have micro-animation between states, to prevent from user interface elements to jump from one state to another.

## Animations

Every change of state of an element is animated, none of them jumps from one state to another:

- Buttons, menu items and rows: hover, focus, pressed, selected and disabled states fade in and out
- Context menus, menus, sheets and toasts: they fade and move slightly when they appear or disappear, the sheets' background darkens progressively
- Colors that depend on a cover art (detail pages/views, Now Playing) blend from the previous cover art's colors to the new ones
- Elements that are added to, removed from or moved inside a list (queue, toasts, selection) glide to their place

Micro-animations are short (between 150 and 300 milliseconds), use an ease-out curve, and never delay the user from acting. When the user asked their device to reduce motion (`prefers-reduced-motion` on the web, Reduce Motion on iOS), movements are removed and only fades remain, or nothing at all.

## Responsiveness

The web app is responsive, from phones to wide screens. An element adapts to the space it has, it is never stretched, cut, or clipped out of its container, nor out of the screen. Rows of elements, especially of buttons, wrap or stack when they do not fit, and the content of an element never overlaps the content of another.

Elements are sized with relative units rather than fixed widths, and nothing has a minimum width bigger than the screen.

> *See "Views and pages" for margins and horizontal scrolling*

## Contrast

Nafyn conforms to the WCAG AAA contrast, everywhere. Body text has a contrast ratio of at least 7:1, large text and interface components (buttons, symbols, borders) at least 4.5:1, and information is never carried by color alone.

Text and symbols are white or black, picked depending on the background behind them, so that the contrast is always enough, including on pages/views that are colored using a cover art. Only buttons and other interactive elements can use colors from the *Colors* table, and they must still be compliant with the contrast ratios above against the background they sit on.

The red `#e06666ae` of the *Colors* table cannot reach these ratios with a label on it, nor as text on the default background. Therefore, in red elements, the "red" is split in two, both keeping the same hue:

- Red fills (filled destructive buttons, red toasts) use a deeper red, `#a02c2e`, with a white label
- Red text, symbols and borders (hollow destructive buttons, destructive context menu actions, error messages) use a lighter red, `#ff9e9e`, on dark backgrounds (on iOS, in the "System" theme and in light mode, the deeper `#a02c2e` is used instead)

## Text fields

All text fields (text inputs, search fields, password fields, text areas, pickers…) are designed by Nafyn, no field ever uses the default style of the browser. They all share the design of the search field of the header: a transparent background, with a slightly blurred backdrop, rounded corners, text with the same font as the rest of the app, and a visible focus. Their states (hover, focus, disabled, error) are animated.

## Colors

All design guidelines mentionning these colors shall be using the color code associated to it (unless specified).

| **Traditional color** | **Hexa color code to use in Nafyn** |
| --------------------- | ----------------------------------- |
| White                 | `#ffffffae`                         |
| Red                   | `#e06666ae`                         |
| Green                 | `#66e086ff`                         |
| Orange                | `#e0a666ff`                         |
| Yellow                | `#e0c666ff`                         |
| Background color      | `#2a2a27ff`                         |

## Buttons

Buttons are clicked on devices with a pointer/cursor, and are tapped on mobile devices (phones, tablets, wall-mounted devices…), never show "Click" on mobile devices, and never show "Tap" on devices with a pointer/cursor.

Buttons may include a symbol, text, a symbol and text. Whatever the button's content, it should always try to use the maximum width available for the button, without going out of the button's bounds. If it cannot use the content's full width, result to clip text with an ellipsis, or lower the button's content to fit the button by height **or** by width.

When buttons are aligned vertically and/or horizontally, all buttons should have the same height (when aligned horizontally) **or** same width (when aligned vertically), whatever the button's content

Disabled buttons always have an opacity applied of `174` (out of `255`). On Filled/Hollow buttons, this disabled opacity adds up on top of the `174` (totalling to `118` out of `255`) existing in the color. 

Disabled buttons always show a `not-allowed` cursor if possible.

### Filled & Hollow

There are 2 styles available for primary action buttons:

- Filled
- Hollow

Both buttons have a solid 1-pixel border colored `#ffffffae` by default. And only on the filled button, the button's background is also `#ffffffae` by default.

Both buttons can turn red, if they're considered "destructive".

Both buttons are pill-shaped, with a `0.6em`-high padding (CSS code, should be converted in SwiftUI), no regulation is applied for horizontal padding except that it should always prioritize the button's content rather than the button's design (padding), without losing the pill shape.

The content of a Filled or Hollow button is always centered, horizontally and vertically, in the button's frame, and never clips out of it.

### Icon-only buttons

A button that only has a symbol always has a size ratio of 1:1 (a circle), and its symbol takes at least 70% of the button's width. This applies to every button with only a symbol, whatever the page, like the "delete" button of a request, or the "New playlist" (+) button. They have an accessible label, and a tooltip on devices with a pointer/cursor, since no text explains them.

### "Select" buttons (web)

Only on the web, "Select" buttons are exclusively used for the bulk editing feature, available in the library pages. They're have two (2) goals for the user:

This is a fallback for iOS's Liquid Glass effect in toolbars, where rests the "Select" button on the Nafyn iOS app.

> *See "Library" to understand how that button works in its entirety*\
> *See "Toolbars" for more information about toolbar designs*

## Links

Links appear slightly differently than buttons for the most part. Links are completely white (`#ffffffff`) and are underlined using the *Instrument Serif* font italicized.

But, in the album/track detail view (and their library counterpart), have to conform to the WCAG AAA contrast (see "Contrast"). It is possible for links to turn completely black for constrast purposes only.

On iOS, tapping on a link doesn't open it in Safari directly, but rather it opens a sheet with the web view, using UIKit's [`WKWebView`](https://developer.apple.com/documentation/webkit/wkwebview).

## Context Menus

On mobile, users tap and holds an element, whilst on PC, users use their right-click. This triggers the context menu opening for the element. Usually, the context menu opens to the right of the click event unless the context menu would clip out of used device.

Different elements should have different context menus, components should always have the same context menus whatever the way the component is used (unless specified otherwise).

On the iOS app, the context menu should use the native [`contextMenu`](https://developer.apple.com/documentation/swiftui/view/contextmenu(menuitems:preview:)) modifier, with or without a custom context menu preview.

- Example (web): The [`MediaBox`](https://github.com/lumaa-dev/Nafyn/blob/main/app/components/MediaBox.vue) component should always have the same context menu, whatever its use. While [`ArtistBox`](https://github.com/lumaa-dev/Nafyn/blob/main/app/components/ArtistBox.vue) should have a a different context menu.
- Example (iOS): The [`MusicCard`](https://github.com/lumaa-dev/NafynApp/blob/main/Nafyn/Components/MusicCard.swift) should always have the same context menu, whatever the `View` it's from. While [`TrackRow`](https://github.com/lumaa-dev/NafynApp/blob/main/Nafyn/Components/TrackRow.swift) should have a different context menu.

A context menu is shown as text (with the *Instrument* font) on the web, and with a [`Label`](https://developer.apple.com/documentation/swiftui/label) on iOS (which may be nested in a [`ControlGroup`](https://developer.apple.com/documentation/swiftui/controlgroup)). Some context menus may have:

- Destructive actions, written in red (with a `Color.red` symbol on iOS, do not use Nafyn's red color)
- Nested menus, which are indicated with an arrow

Some pages/views may have a "Select" button, which allows users to select multiple elements in a list. Using the context menu trigger, instead of triggering the context menu for only one element, it will trigger the context menu for all the selected elements, showing the amount of selected elements isn't considered as a section header. The "Select" button cannot be in a context menu whatsoever.

Actions that begin with the same word, like "View" or "Share", can be **optionally** nested into a sub-menu. Menu Example: ["View" > "Artist" | "Album" | "Track"]

Additionally, all context menu actions are sorted in categories, which themselves are sorted by importance and usage (as listed below in *Categories*).

### Categories

The context menu categories are manually sorted in this order:

1. Playback actions - Example: "Play", "Shuffle", "Add/Remove to queue"
2. "View" and playlists - Example: "View artist", "View playlist", "View album", "View track", "Add to playlist", "View user"
3. Modifications - Example: "Change albums", "Edit metadata", "Change cover art"
4. Destructive actions - Example: "Delete track", "Remove from playlist", "Delete from downloads", "Delete user"

Context menu categories do not have a section header or footer, and are separated with a small divider line (on iOS, use [`Divider`](https://developer.apple.com/documentation/swiftui/divider)).

## Menus

Menus in Nafyn are a mix of a button and a context menu. There are 2 perfect examples for this that are applied in Nafyn already:

- On iOS, [`LibraryAlbumDetailView`](https://github.com/lumaa-dev/NafynApp/blob/main/Nafyn/Views/Paths/LibraryAlbumDetailView.swift#L122-L153) uses a toolbar menu that reuses the exact same actions and are ordered the same as the library album's context menu.
- On the web, [`/l/tracks`](https://github.com/lumaa-dev/Nafyn/blob/main/app/pages/l/tracks.vue#L29-L31) has a vertical ellipsis menu available on all track's rows, showing the menu using the exact same context menu layout and actions.

It shows up as a button, and when clicked/tapped, it shows the context menu "attached" to the element.

> *See "Context Menus" and "Buttons" for more information about how they work, and how they look*\
> *See "Toolbars" for more information about toolbar designs*

## Graphics & Charts

Graphics and charts allows users to see easily an aggregation of data into a visual, like a pie chart, a line chart, a progress bar, etc...

On all graphics and charts, you always have to show a legend at the bottom leading (left) corner of the chart. With the color, its associated label, and its associated value.

All values must be ordered by descending or ascending. **No randomized order**.

The primary color for graphics and charts is **`Color.blue` on iOS**, and **orange on the web**. Alternatively, other colors can be used to represent other "columns" of data.

> *See "Colors" for the exact color codes for the web*

## Modals / Sheets

On iOS, use the default [`sheet`](https://developer.apple.com/documentation/swiftui/view/sheet(ispresented:ondismiss:content:)).

On the web, on large screens, Nafyn re-uses a similar sheet design from [iPadOS](https://developer.apple.com/design/human-interface-guidelines/sheets#iOS-iPadOS) or [macOS](https://developer.apple.com/design/human-interface-guidelines/sheets#macOS):

- There is a "compact" mode for sheets, where little information can be displayed. It is vertically large, and allows to display a few paragraphs of texts, with a few actions.
- There is a "large" mode for sheets, where a lot of information can be displayed, like forms. It is the same size ratio as the whole viewport, it is made for text fields, sliders, pickers, etc…

All sheets should have a "Close" button in its toolbar on the top leading (top-left) edge of the sheet, which requires the sheet's content to have more top padding (to prevent overlaying the toolbar and the content).

All buttons in the toolbar of a sheet are of one singular type: the one of the "Close" button (`modal-close`). Primary actions (like "Save" or "Move") on the trailing edge, and the "Close" button, share the same shape, size and style, in every sheet. Only the color can differ, to show the action type (see "Toolbars").

Buttons in a sheet use symbols rather than text (a cross for "Close", a checkmark for "Save", etc…) **most of the time**, especially on smaller screens, where text does not fit. These buttons are icon-only buttons (see "Icon-only buttons"), and so they have an accessible label and a tooltip.

The title of a sheet is always centered in the toolbar, whatever the content of the toolbar. The leading and trailing areas of the toolbar have the same width, so that having a different number of buttons on each side never moves the title.

When a sheet is opened, on the web, the background darkens and is no longer interactable. This prevents users from interacting with buttons in the background, and focusing on the active sheet.

> *See "Toolbars" for more information about toolbar usage and styling*

---

On smaller screens, on the web, the sheet re-uses a similar sheet design from [iOS](https://developer.apple.com/design/human-interface-guidelines/sheets#iOS-iPadOS):

Sheets take up 95% of the whole vertical viewport, toolbar is at the top with the "Close" button on the top leading (top left) edge. There are no "compact" or "large" modes. Buttons should be adapted for large widescreen sheets (see above) and small vertical screens.

> *See "Toolbars" for more information about toolbar designs*

## Toolbars

On iOS, use the native [`toolbar`](https://developer.apple.com/documentation/swiftui/view/toolbar(content:)), it is also heavily recommended to use [`Label`](https://developer.apple.com/documentation/swiftui/label)s in toolbars for iPhone Duo support, but text can also be inputted if no symbols match with the action. Instead of making a ellipsis menu using [`ToolbarOverflowMenu`](https://developer.apple.com/documentation/swiftui/toolbaroverflowmenu) for cross compatibility with other Apple devices.

There are a few exceptions to the [`Label`](https://developer.apple.com/documentation/swiftui/label) with icon rule, that are listed below in the sub-section

On the web, outside of sheets, all toolbar actions sit primarily at the bottom right corner of the viewport. Actions can also be placed at the bottom left corner, but these are for secondary actions.

They are designed a specific way to not obstruct the content behind the toolbar, with 2 primary goals:

- Show the user using colors the action type (Destructive, cancel, toggle)
- Blend in easily using transparent (color with transparency possible) backgrounds, to be barely noticeable when unecessary to the user

On the web, in sheets, are primarily at the top, but can also be at the bottom. Bottom toolbar actions should be secondary, or quick actions.

Whatever the toolbar's location, if the source of the toolbar is a scroll view

> *See "Modals / Sheets" for more information about how modals look and feel*

### Text-only toolbar buttons

The buttons listed below should **never** have an icon associated with it, even on iOS:
- "Select" button (**"Done" button NOT included**)

## Toasts

Toasts behave the same way on both the iOS and web app. But are designed slightly differently due to platform limitations:

- On iOS, toasts use Liquid Glass and have only one default style. Toasts show a [`Label`](https://developer.apple.com/documentation/swiftui/label) with an icon and text. Toasts are handled using [`unionst/union-toast`](https://github.com/unionst/union-toast). Toasts don't use the *Instrument* font.
- On the web, toasts use a transparent colored background, they also can stack one-another (maximum of 3 toasts). Toasts use *Instrument* font. Toasts have 3 styles:
    - Red - Mainly used for error messages
    - Green - Mainly used for success messages
    - Default - Used for any other messages

---

Toasts are made to "respond" to a **non-changing screen** action trigged by the user. Except for errors, toasts should be short and simple, 1-line maximum.

- If the action succeeds, it should send a green toast
- If the action fails, it should send a red toast (error message)
- Other actions should use a default toast

Although there are 2 alternative styles for toasts, the default style for toasts is the least used throughout the Nafyn web app.

> *See "Error messages" for more information about sending an error message at the right time*

## Error messages

Errors are common in Nafyn, because it depends on multiple third-party services all at once. Most of the time, errors come from Nafyn HTTP requests. Therefore, Nafyn requires both human-readable error messages, as well as developer-specific errors.

When to show an error on-screen:

- When a Nafyn HTTP request's code isn't `200` or `404`.
- After a user triggered an action (clicking, tapping, typing, etc...).

If these conditions are met, then the error shall be shown on the user's screen. Otherwise, keep the error out of the user's screen.

If the triggered action **should've caused a screen change** like the loading lyrics panel, a failed search, an album not loading, the statistics page not properly loading, etc... It will show the error message using a secondary foreground color, at the exact place where the screen change should've happened.

If the triggered action shouldn't' have caused a screen change like requesting a track, deleting an album, editing metadata, etc... It will show the error as red toast.

> *See "Toasts" for more information about using toasts, and toast styles.*

## Sharing

Sharing content from Nafyn to third-party services like Discord, Instagram, Signal, etc...

Only one item can be shared at a time, no bulk sharing.

On the web, the sharing feature copies the link of the selected item.

The sharing action can be found either:
- As a Context Menu action
- (on iOS only) in the Toolbar

Exclusively on iOS, users can either share their selected item as a link, or as an image.
Sharing an image allows users to share their content in their Instagram or Snapchat stories, all images have to have a 9:16 ratio.
Both sharing an image and sharing a link use Apple's native [`ShareLink`](https://developer.apple.com/documentation/swiftui/sharelink).

Items that are private (like library tracks, library albums, private playlist...) cannot be shared. Items that **can** be public (playlists), may not show the "Share" button in the toolbar when it is private, it may be disabled from the context menu. If the item is public, the share button can be in the toolbar (but not necessarily), and the context menu action is enabled.

> *See "Toolbars" for more information about toolbar styling and usage*\
> *See "Context Menu" for more information about action categories*