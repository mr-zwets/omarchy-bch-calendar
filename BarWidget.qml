import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// BCH calendar. The pill shows a calendar icon and the time left to the
// next date, or "today" on any tracked day. Click for the list, soonest
// first: network upgrade (15 May, 12:00 UTC; 2027 is CHIP-2025-03, 1-minute
// blocks), upgrade lock-in (15 Nov), halving, BCH birthday, whitepaper day,
// genesis block, pizza day. Click the halving row for its details with a
// to-the-second countdown. Middle click refreshes.
//
// Halving math follows the CHIP's tick model, so the ETA stays right across
// the switch to 1-minute blocks; the halving *height* is an estimate until
// the activation block is on chain, then exact.
//
// Network: fetch.mjs opens one TLS connection to a Fulcrum server (Electrum
// protocol, port 50002) every `pollSeconds` (default 10 min), failing over
// through the curated Cashonize list. Optional shell.json settings:
//   "network": "mainnet" | "chipnet"
//   "servers": ["my.fulcrum.host:50002", ...]
//   "oneMinuteActivation": 1810382400   (unix MTP; 0 = don't assume it)
//   "pill": "next" | "upgrade" | "halving"   (which date the pill counts to)
//   "pollSeconds": 600
BarWidget {
  id: root
  moduleName: "mrzwets.bch-calendar"

  readonly property string networkName: String(setting("network", "mainnet")) === "chipnet" ? "chipnet" : "mainnet"
  readonly property var net: Model.network(networkName)
  readonly property int pollSeconds: Math.max(60, Number(setting("pollSeconds", 600)) || 600)
  readonly property real activation: {
    var a = Number(setting("oneMinuteActivation", net.activation))
    return isFinite(a) && a >= 0 ? a : net.activation
  }
  readonly property string pillMode: String(setting("pill", "next"))
  readonly property var servers: {
    var s = setting("servers", [])
    if (typeof s === "string") s = s.split(",")
    s = Array.isArray(s) ? s.map(function(x) { return String(x).trim() })
      .filter(function(x) { return /^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(x) }) : []
    return s.length ? s : net.servers
  }

  property var chain: null
  property string error: ""
  property double updatedAt: 0
  property double now: Date.now()
  property bool cardOpen: false
  property string page: ""   // "", "halving" or "upgrade"
  property int failures: 0
  readonly property string cachePath: (Quickshell.env("XDG_CACHE_HOME") || Quickshell.env("HOME") + "/.cache")
    + "/bch-calendar-" + networkName + ".json"

  readonly property var halving: Model.halving(chain, activation)
  readonly property var upgrade: Model.nextUpgrade(chain, now)
  readonly property var act: Model.activationState(chain, activation)
  // The next upgrade is the 1-minute-block one (until it activates).
  readonly property bool fastUpgrade: activation > 0 && upgrade.time === activation
  readonly property var events: Model.events(chain, activation, now)
  readonly property var pillEvent: {
    for (var i = 0; i < events.length; i++) if (events[i].today) return events[i]
    for (var j = 0; j < events.length; j++)
      if (events[j].key === pillMode) return events[j]
    return events.length ? events[0] : null
  }
  readonly property color fg: bar ? bar.barForeground : Color.foreground
  readonly property color muted: Qt.darker(fg, 1.4)
  readonly property color bchGreen: "#0ac18e"
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  implicitWidth: vertical ? barSize : row.implicitWidth + Style.spacing.controlPaddingX * 2
  implicitHeight: vertical ? row.implicitHeight + Style.spacing.controlPaddingY * 2 : barSize

  // PopupCard closes through its owner's close(); without it the `open`
  // binding is overwritten and the card opens only once.
  function close() { cardOpen = false }

  function toggleCard() {
    now = Date.now()
    page = ""
    cardOpen = !cardOpen
  }

  function refresh() {
    if (fetcher.running) return
    var args = ["node", Qt.resolvedUrl("fetch.mjs").toString().replace("file://", ""),
                "--activation", String(Math.floor(activation))]
    // An activation height 10+ blocks deep is final (BCHN finalizes at 10):
    // pass it on so the binary search runs only once.
    if (chain && chain.activationHeight && chain.height - chain.activationHeight >= 10)
      args.push("--ha", String(chain.activationHeight))
    fetcher.command = args.concat(servers)
    fetcher.running = true
  }

  component Label: Text {
    textFormat: Text.PlainText
    color: root.muted
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }
  component Value: Text {
    textFormat: Text.PlainText
    color: root.fg
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  Row {
    id: row
    anchors.centerIn: parent
    spacing: Style.spacing.sm
    opacity: root.error !== "" && root.pillEvent && root.pillEvent.key === "halving" ? 0.55 : 1

    Text {
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: "󰃭"
      color: root.bchGreen
      font.family: root.fontFamily
      font.pixelSize: Math.round(Style.font.body * 1.1)
    }
    Text {
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: root.pillEvent ? Model.leftText(root.pillEvent.time, root.now, root.pillEvent.today) : "—"
      color: root.pillEvent && root.pillEvent.today ? root.bchGreen : root.fg
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      font.bold: !!root.pillEvent && root.pillEvent.today
      opacity: 0.85
    }
  }

  MouseArea {
    anchors.fill: parent
    acceptedButtons: Qt.LeftButton | Qt.MiddleButton
    cursorShape: Qt.PointingHandCursor
    onClicked: function(mouse) {
      if (mouse.button === Qt.MiddleButton) { root.refresh(); return }
      root.toggleCard()
    }
  }

  PopupCard {
    id: card
    anchorItem: root
    owner: root
    bar: root.bar
    open: root.cardOpen
    contentWidth: card.fittedContentWidth(Style.space(360))
    contentHeight: card.fittedContentHeight(cardColumn.implicitHeight)

    Column {
      id: cardColumn
      anchors.fill: parent
      spacing: Style.space(6)

      // ── List ────────────────────────────────────────────────
      Text {
        visible: root.page === ""
        textFormat: Text.PlainText
        text: "󰃭  BCH calendar" + (root.networkName === "chipnet" ? "  (chipnet)" : "")
        color: root.fg
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: true
      }

      Repeater {
        model: root.page === "" ? root.events : []

        Item {
          id: eventRow
          required property var modelData
          readonly property bool clickable: modelData.key === "halving" || modelData.key === "upgrade"
          width: cardColumn.width
          height: rowContent.implicitHeight + Style.space(6)

          Rectangle {
            anchors.fill: parent
            anchors.margins: -Style.space(4)
            radius: Style.space(6)
            color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.08)
            visible: eventRow.clickable && rowMouse.containsMouse
          }

          Row {
            id: rowContent
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(10)

            Text {
              anchors.verticalCenter: parent.verticalCenter
              width: Style.space(18)
              textFormat: Text.PlainText
              text: eventRow.modelData.icon
              color: root.bchGreen
              font.family: root.fontFamily
              font.pixelSize: Math.round(Style.font.body * 1.15)
            }
            Column {
              // Leaves room for the time-left column on the right.
              width: eventRow.width - Style.space(28) - leftCol.width - Style.space(12)
              Text {
                width: parent.width
                elide: Text.ElideRight
                textFormat: Text.PlainText
                text: eventRow.modelData.name + (eventRow.clickable ? "  ›" : "")
                color: root.fg
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                font.bold: true
              }
              Text {
                width: parent.width
                elide: Text.ElideRight
                textFormat: Text.PlainText
                text: Model.dayText(eventRow.modelData.time)
                  + (eventRow.modelData.detail ? " · " + eventRow.modelData.detail : "")
                color: eventRow.modelData.milestone ? root.bchGreen : root.muted
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }

          Text {
            id: leftCol
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            horizontalAlignment: Text.AlignRight
            textFormat: Text.PlainText
            text: Model.leftText(eventRow.modelData.time, root.now, eventRow.modelData.today)
            color: eventRow.modelData.today ? root.bchGreen : root.fg
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: eventRow.modelData.today
          }

          MouseArea {
            id: rowMouse
            anchors.fill: parent
            enabled: eventRow.clickable
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: { root.now = Date.now(); root.page = eventRow.modelData.key }
          }
        }
      }

      // ── Halving details ─────────────────────────────────────
      Text {
        visible: root.page === "halving"
        textFormat: Text.PlainText
        text: "‹  Halving #" + (root.halving ? root.halving.number : "—")
        color: root.fg
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: true
        MouseArea {
          anchors.fill: parent
          cursorShape: Qt.PointingHandCursor
          onClicked: root.page = ""
        }
      }

      Text {
        visible: root.page === "halving"
        textFormat: Text.PlainText
        text: root.halving ? Model.countdown(root.halving.eta, root.now) : "loading…"
        color: root.fg
        font.family: root.fontFamily
        font.pixelSize: Style.font.title
        font.bold: true
      }

      Rectangle {
        visible: root.page === "halving"
        width: cardColumn.width
        height: Style.space(6)
        radius: height / 2
        color: Qt.rgba(root.fg.r, root.fg.g, root.fg.b, 0.15)
        Rectangle {
          width: root.halving ? parent.width * Math.min(1, root.halving.progress) : 0
          height: parent.height
          radius: parent.radius
          color: root.bchGreen
        }
      }

      Grid {
        visible: root.page === "halving"
        columns: 2
        columnSpacing: Style.space(12)
        rowSpacing: Style.space(4)

        Label { text: "Estimated" }
        Value { text: root.halving ? Model.dateText(root.halving.eta) + " · " + Model.utcTime(root.halving.eta) : "—" }

        Label { text: "Block height" }
        Value { text: root.chain ? Model.num(root.chain.height) : "—" }

        Label { text: "Halving block" }
        Value { text: root.halving ? (root.halving.exact ? "" : "≈ ") + Model.num(root.halving.height) : "—" }

        Label { text: "Blocks left" }
        Value {
          text: root.halving ? (root.halving.exact ? "" : "≈ ") + Model.num(root.halving.blocksLeft)
            + " · " + (root.halving.progress * 100).toFixed(1) + "% of era" : "—"
        }

        Label { text: "Reward / 10 min" }
        Value { text: root.halving ? Model.bch(root.halving.per10Now) + " → " + Model.bch(root.halving.per10Next) + " BCH" : "—" }

        Label { text: "Avg block" }
        Value { text: root.chain ? Model.blockTime(Model.avgBlockSeconds(root.chain)) + " (last 2016)" : "—" }
      }

      Label {
        visible: root.page === "halving" && !!root.halving && !root.halving.exact
        width: cardColumn.width
        wrapMode: Text.WordWrap
        font.pixelSize: Style.font.caption
        text: root.halving ? "≈ assumes 1-minute blocks from May 2027 (block " + Model.num(root.halving.legacyHeight)
          + " with 10-minute blocks). The date is the same either way." : ""
      }

      // ── Upgrade details ─────────────────────────────────────
      Text {
        visible: root.page === "upgrade"
        textFormat: Text.PlainText
        text: "‹  " + (root.fastUpgrade ? "1-minute blocks upgrade" : "Network upgrade " + root.upgrade.year)
        color: root.fg
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        font.bold: true
        MouseArea {
          anchors.fill: parent
          cursorShape: Qt.PointingHandCursor
          onClicked: root.page = ""
        }
      }

      Text {
        visible: root.page === "upgrade"
        textFormat: Text.PlainText
        text: root.upgrade.done ? "activated ✓" : root.upgrade.activating ? "activating…"
          : Model.countdown(root.upgrade.time, root.now)
        color: root.fg
        font.family: root.fontFamily
        font.pixelSize: Style.font.title
        font.bold: true
      }

      Grid {
        visible: root.page === "upgrade"
        columns: 2
        columnSpacing: Style.space(12)
        rowSpacing: Style.space(4)

        Label { text: "MTP reaches" }
        Value { text: Model.dayText(root.upgrade.time) + " · " + Model.utcTime(root.upgrade.time) }

        Label { text: "Chain MTP" }
        Value { text: root.chain ? Model.dayText(root.chain.tipMtp) + " · " + Model.utcTime(root.chain.tipMtp) : "—" }

        Label { visible: root.fastUpgrade; text: "Activation block" }
        Value {
          visible: root.fastUpgrade
          text: root.act.active ? Model.num(root.act.ha)
            : root.act.ha ? "≈ " + Model.num(root.act.ha) : root.chain ? "finding…" : "—"
        }

        Label { visible: root.fastUpgrade; text: "Block time" }
        Value { visible: root.fastUpgrade; text: "10 min → 1 min" }

        Label { visible: root.fastUpgrade; text: "Reward / block" }
        Value {
          visible: root.fastUpgrade
          text: root.halving ? Model.bch(root.halving.per10Now) + " → " + Model.bch(Math.floor(root.halving.per10Now / 10)) + " BCH" : "—"
        }

        Label { visible: root.fastUpgrade; text: "Halving block" }
        Value {
          visible: root.fastUpgrade
          text: root.halving ? Model.num(root.halving.legacyHeight) + " → " + (root.halving.exact ? "" : "≈ ")
            + Model.num(root.halving.height) : "—"
        }
      }

      Label {
        visible: root.page === "upgrade"
        width: cardColumn.width
        wrapMode: Text.WordWrap
        font.pixelSize: Style.font.caption
        text: "Activates at the first block whose median time past (last 11 blocks) reaches 12:00 UTC, usually about an hour later."
          + (root.fastUpgrade ? " Rewards per 10 minutes and the halving date stay the same." : "")
      }

      // ── Data source + refresh (detail pages) ────────────────
      Text {
        visible: root.page !== ""
        width: cardColumn.width
        wrapMode: Text.WordWrap
        textFormat: Text.PlainText
        text: (fetcher.running ? "refreshing… · "
            : root.error !== "" ? "refresh failed, retrying · " : "")
          + (root.chain && root.chain.server ? root.chain.server + " · " : "")
          + "updated " + Model.ageText(root.updatedAt, root.now) + " · 󰑐 refresh"
        color: root.error !== "" ? Color.urgent : refreshMouse.containsMouse ? root.fg : root.muted
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        MouseArea {
          id: refreshMouse
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: root.refresh()
        }
      }

    }
  }

  // `qs ipc -p /usr/share/omarchy/shell call mrzwets.bch-calendar toggle`
  IpcHandler {
    target: "mrzwets.bch-calendar"
    function toggle(): void { root.toggleCard() }
    function halving(): void { root.now = Date.now(); root.page = "halving"; root.cardOpen = true }
    function upgrade(): void { root.now = Date.now(); root.page = "upgrade"; root.cardOpen = true }
    function refresh(): void { root.refresh() }
  }

  Process {
    id: fetcher
    workingDirectory: Quickshell.env("HOME")
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var parsed = Model.parse(text)
        if (parsed) {
          root.chain = parsed
          root.updatedAt = Date.now()
          root.now = root.updatedAt
          root.error = ""
          root.failures = 0
          cacheFile.setText(JSON.stringify(parsed))
          return
        }
        // Every server failed (offline at login, usually): keep the cached
        // chain on screen and retry soon.
        root.error = "offline"
        root.failures++
        retryTimer.interval = Model.retryMs(root.failures, root.pollSeconds * 1000)
        retryTimer.restart()
      }
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: if (text.trim() !== "") console.warn("bch-calendar:", text.trim())
    }
  }

  Timer {
    interval: root.pollSeconds * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    id: retryTimer
    repeat: false
    onTriggered: root.refresh()
  }

  // Last good chain state, shown at login before the first fetch lands.
  FileView {
    id: cacheFile
    path: root.cachePath
    printErrors: false
    blockLoading: true
    onLoaded: {
      var cached = Model.parse(text())
      if (!cached || root.chain) return
      root.chain = cached
      root.updatedAt = cached.fetchedAt * 1000
    }
  }

  // Seconds tick while a details page is open; otherwise minutes do.
  Timer {
    interval: root.cardOpen && root.page !== "" ? 1000 : 30000
    running: true
    repeat: true
    onTriggered: root.now = Date.now()
  }
}
