import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useAuth, useData, useJobs } from "../lib/store";
import { Icon, type IconName } from "./icons";
import { ProjectSelect } from "./ui";

const NAV: { to: string; label: string; icon: IconName; mobile?: boolean }[] = [
  { to: "/", label: "Generate", icon: "sparkles", mobile: true },
  { to: "/image", label: "NX Image", icon: "image", mobile: true },
  { to: "/video", label: "NX Video", icon: "video", mobile: true },
  { to: "/library", label: "Library", icon: "grid", mobile: true },
  { to: "/projects", label: "Projects", icon: "folder" },
  { to: "/history", label: "History", icon: "clock", mobile: true },
  { to: "/models", label: "Models", icon: "cpu" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

export function Layout({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const { user } = useAuth();
  const { byId, connected } = useJobs();
  const { currentProject, setCurrentProject } = useData();
  const active = [...byId.values()].filter((j) => ["queued", "starting", "processing", "encoding"].includes(j.status)).length;
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo.svg" alt="" />
          <div>
            NX STUDIO
            <small>Image · Video</small>
          </div>
        </div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
            <Icon name={n.icon} />
            {n.label}
            {n.to === "/history" && active > 0 && <span className="badge processing">{active}</span>}
          </NavLink>
        ))}
        <div className="sidebar-foot">
          <div className="row" title={connected ? "Temps réel connecté" : "Reconnexion…"}>
            <span className={`conn${connected ? "" : " off"}`} /> {connected ? "Temps réel" : "Hors ligne"}
          </div>
          <div className="ellipsis">{user?.email}</div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <h1 className="ellipsis">{title}</h1>
          <div className="spacer" />
          {actions}
          <div style={{ width: 180 }} className="project-pick">
            <ProjectSelect allowAll value={currentProject} onChange={setCurrentProject} />
          </div>
        </header>
        <main className="page">{children}</main>
      </div>
      <nav className="mobile-nav">
        {NAV.filter((n) => n.mobile).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon name={n.icon} />
            {n.label.replace("NX ", "")}
          </NavLink>
        ))}
        <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : "")}>
          <Icon name="settings" />
          Plus
        </NavLink>
      </nav>
    </div>
  );
}
