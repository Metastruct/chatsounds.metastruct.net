import { useState } from 'react'
import { Icon } from './Icon'

/**
 * metastruct.net's navbar, reproduced.
 *
 * Same structure as theirs: the logo on the left, site links in `navbar-start`,
 * and this tool's own links in `navbar-end` -- which is where their site puts
 * API and Log in. The logo goes back to metastruct.net, since that is where the
 * rest of the site lives; this service is just one page of it.
 */

const SITE_LINKS = [
  {
    label: 'Chat',
    icon: 'chat' as const,
    items: [
      { label: 'IRC', href: 'https://metastruct.net/irc' },
      { label: 'Discord', href: 'https://www.metastruct.net/discord' },
    ],
  },
  {
    label: 'Forums',
    icon: 'forum' as const,
    href: 'https://steamcommunity.com/groups/metastruct/discussions',
  },
  { label: 'GitHub', icon: 'github' as const, href: 'https://github.com/metastruct' },
  {
    label: 'Merchandise',
    icon: 'shopping' as const,
    href: 'https://merch.metastruct.net',
  },
]

interface Props {
  onHome: () => void
}

export function Navbar({ onHome }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <nav className="navbar" aria-label="main navigation">
      <div className="container is-wide">
        <div className="navbar-brand">
          <a
            href="https://metastruct.net"
            title="Meta Construct"
            rel="noreferrer"
          >
            <img src="/logo.svg" className="logo navbar-item" alt="Meta Construct" />
          </a>
          <button
            type="button"
            className={`navbar-burger${open ? ' is-active' : ''}`}
            aria-label="menu"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </button>
        </div>

        <div className={`navbar-menu${open ? ' is-active' : ''}`}>
          <div className="navbar-start">
            {SITE_LINKS.map((link) =>
              link.items ? (
                <div key={link.label} className="navbar-item has-dropdown is-hoverable">
                  <button type="button" className="navbar-link">
                    <Icon name={link.icon} />
                    <span>{link.label}</span>
                  </button>
                  <div className="navbar-dropdown">
                    {link.items.map((item) => (
                      <a
                        key={item.label}
                        className="navbar-item"
                        href={item.href}
                        rel="noreferrer"
                      >
                        {item.label}
                      </a>
                    ))}
                  </div>
                </div>
              ) : (
                <a
                  key={link.label}
                  className="navbar-item"
                  href={link.href}
                  rel="noreferrer"
                >
                  <Icon name={link.icon} />
                  <span>{link.label}</span>
                </a>
              ),
            )}
          </div>

          <div className="navbar-end">
            <button
              type="button"
              className="navbar-item"
              onClick={() => {
                setOpen(false)
                onHome()
              }}
            >
              <Icon name="folderMusic" />
              <span>Uploads</span>
            </button>

            <div className="navbar-item has-dropdown is-hoverable">
              <button type="button" className="navbar-link">
                <Icon name="waveform" />
                <span>Chatsounds</span>
              </button>
              <div className="navbar-dropdown is-right">
                <a
                  className="navbar-item"
                  href="https://github.com/Earu/neo-chatsounds"
                  rel="noreferrer"
                >
                  neo-chatsounds
                </a>
                <a
                  className="navbar-item"
                  href="https://github.com/Metastruct/garrysmod-chatsounds"
                  rel="noreferrer"
                >
                  garrysmod-chatsounds
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </nav>
  )
}
