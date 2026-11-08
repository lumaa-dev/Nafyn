# Nafyn Design Guidelines

# Views and pages

> Note: View are used in SwiftUI, for the Nafyn iOS app. Pages are used on any web browser, on any device, for the Nafyn web service. Do not use "page" or "view" whatever happens to talk about a Nafyn screen.

By default, the background color used is `#2a2a27` and the text color is `#ffffffae`.

Content never touches the edges of the screen. On small screens, every page keeps a small horizontal margin (at least 16px) on both sides, so that content stays away from the edges of the display it is used from. No page is edge-to-edge, the insights page included.

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

> *See "Context Menus" for information about utilizing context menus in Nafyn*.
> *See "Toolbars" for more information about toolbar designs*

## Track/Album Detail view

Track or album detail views (and also Library track/album detail views) show what the name implies: Details of the chosen track or album the user has clicked or tapped on.

Detail views are colored with the cover art's primary color, therefore the label's color is adapted between white and black (depending on the cover art's primary color). Also, on iOS only, the cover art is expanded above the app's safe area using [`backgroundExtensionEffect`](https://developer.apple.com/documentation/swiftui/view/backgroundextensioneffect()) and [`safeAreaInset`](https://developer.apple.com/documentation/swiftui/view/safeareainset(edge:alignment:spacing:content:)-6gwby).

Detail views always conform to the WCAG AAA contrast (see "Contrast"): every label, symbol and button is checked against the cover art's primary color behind it, not only against the default background color.

Album detail views show the track number on each track, unless it doesn't have one. Track rows in an album detail view never show the cover art: the cover art is already the album's, and showing it next to the track number clutters the row.

On iOS, detail views always have a [`ToolbarOverflowMenu`](https://developer.apple.com/documentation/swiftui/toolbaroverflowmenu) containing the same actions that were linked to the track/album row (or even [`MusicCard`](https://github.com/lumaa-dev/NafynApp/blob/main/Nafyn/Components/MusicCard.swift)) unless it creates recursion (like a navigation recursion).

> *See "Toolbars" for more information about toolbar designs*

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

Whenever synchronized lyrics are available, users can click/tap on a lyric, to automatically jump the playback to the lyric's start time.

Optionally, users can toggle on or off in Nafyn's settings to switch the font from Instruments Serif to `sans-serif`.

> *See "Error messages" for more information about displaying errors to users*
> *See "Interface" for more information about fonts*

On iOS, users have additional Liquid Glass controls on the bottom leading edge of the scroll view:

- Translate: Translates the lyrics using the on-device [Foundation Models API](https://developer.apple.com/documentation/foundationmodels), from any language to the app's selected locale.

These iOS-only controls require the scroll view to have a content margin at the top and bottom, and also for visual comfort reasons.

### Queue Panel

The Queue Panel is a scroll view, with 3 categories in that specific order:

1. Song history (capped to 50 songs), from oldest (at the top) to latest (at the bottom of the section)
2. Queue actions: Repeat button and shuffle button
3. Song queue, from index `0` to last index (index `0` here is the next playing song)

By default, the Queue Panel's scroll view starts at the 2nd section ("Queue actions"), therefore, when the user scroll up, it shows them their Song history (section 1). Whilst if users go down from the 2nd section, it shows them their Song queue (section 3).

The Song queue must never show the currently playing song in the queue, or any previously playing song (that's for the Song history). The Song history also must never show the currently playing song in the history, or any song that's up next in the queue (unless they've been played previously).

Repeating a track (using "Repeat One") adds the track only **once** in the history, without duplicating it after each replay.

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
| Background color      | `#2a2a27`                           |

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

> *See "Library" to understand how that button works in its entirety*
> *See "Toolbars" for more information about toolbar designs*

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

> *See "Context Menus" and "Buttons" for more information about how they work, and how they look*
> *See "Toolbars" for more information about toolbar designs*

## Modals / Sheets

On iOS, use the default [`sheet`](https://developer.apple.com/documentation/swiftui/view/sheet(ispresented:ondismiss:content:)).

On the web, on large screens, Nafyn re-uses a similar sheet design from [iPadOS](https://developer.apple.com/design/human-interface-guidelines/sheets#iOS-iPadOS) or [macOS](https://developer.apple.com/design/human-interface-guidelines/sheets#macOS):

- There is a "compact" mode for sheets, where little information can be displayed. It is vertically large, and allows to display a few paragraphs of texts, with a few actions.
- There is a "large" mode for sheets, where a lot of information can be displayed, like forms. It is the same size ratio as the whole viewport, it is made for text fields, sliders, pickers, etc…

All sheets should have a "Close" button in its toolbar on the top leading (top-left) edge of the sheet, which requires the sheet's content to have more top padding (to prevent overlaying the toolbar and the content).

All buttons in the toolbar of a sheet are of one singular type: the one of the "Close" button (`modal-close`). Primary actions (like "Save" or "Move") on the trailing edge, and the "Close" button, share the same shape, size and style, in every sheet. Only the color can differ, to show the action type (see "Toolbars").

Buttons in a sheet use symbols rather than text (a cross for "Close", a checkmark for "Save", etc…), especially on smaller screens, where text does not fit. These buttons are icon-only buttons (see "Icon-only buttons"), and so they have an accessible label and a tooltip.

The title of a sheet is always centered in the toolbar, whatever the content of the toolbar. The leading and trailing areas of the toolbar have the same width, so that having a different number of buttons on each side never moves the title.

When a sheet is opened, on the web, the background darkens and is no longer interactable. This prevents users from interacting with buttons in the background, and focusing on the active sheet.

---

On smaller screens, on the web, the sheet re-uses a similar sheet design from [iOS](https://developer.apple.com/design/human-interface-guidelines/sheets#iOS-iPadOS):

Sheets take up 95% of the whole vertical viewport, toolbar is at the top with the "Close" button on the top leading (top left) edge. There are no "compact" or "large" modes. Buttons should be adapted for large widescreen sheets (see above) and small vertical screens.

> *See "Toolbars" for more information about toolbar designs*

## Toolbars

On iOS, use the native [`toolbar`](https://developer.apple.com/documentation/swiftui/view/toolbar(content:)), it is also heavily recommended to use `Label`s in toolbars for iPhone Duo support, but text can also be inputted if no symbols match with the action. Instead of making a ellipsis menu using [`ToolbarOverflowMenu`](https://developer.apple.com/documentation/swiftui/toolbaroverflowmenu) for cross compatibility with other Apple devices

On the web, outside of sheets, all toolbar actions sit primarily at the bottom right corner of the viewport. Actions can also be placed at the bottom left corner, but these are for secondary actions.

They are designed a specific way to not obstruct the content behind the toolbar, with 2 primary goals:

- Show the user using colors the action type (Destructive, cancel, toggle)
- Blend in easily using transparent (color with transparency possible) backgrounds, to be barely noticeable when unecessary to the user

On the web, in sheets, are primarily at the top, but can also be at the bottom. Bottom toolbar actions should be secondary, or quick actions.

Whatever the toolbar's location, if the source of the toolbar is a scroll view

> *See "Modals / Sheets" for more information about how modals look and feel*

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

