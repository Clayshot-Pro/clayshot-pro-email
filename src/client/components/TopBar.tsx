import type { FormEvent } from "react";
import type { NotificationState } from "../mailTypes";
import { notificationLabel } from "../mailUtils";
import { Icon } from "./Icon";
import { useInstance } from "../instance";

type TopBarProps = {search:string;notificationState:NotificationState;notificationsDisabled:boolean;onSearchChange:(value:string)=>void;onSearch:()=>void | Promise<void>;onToggleNotifications:()=>void};

export function TopBar({search,notificationState,notificationsDisabled,onSearchChange,onSearch,onToggleNotifications}:TopBarProps){
  const {brandName}=useInstance();
  const submitSearch=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();void onSearch()};
  return <header className="desktop-topbar">
    <div className="topbar-brand"><strong className="topbar-brand-title">{brandName}</strong><span className="topbar-brand-divider" aria-hidden="true"/><span className="topbar-context">Private • Personal</span></div>
    <form className="topbar-search" role="search" onSubmit={submitSearch}><Icon name="search" size={18}/><input aria-label="Search mail" type="search" placeholder="Search emails, people, or keywords…" value={search} onChange={e=>onSearchChange(e.target.value)}/>{search?<button className="topbar-search-clear" type="button" aria-label="Clear search" onClick={()=>onSearchChange("")}>×</button>:null}<button className="topbar-search-submit" type="submit"><Icon name="search" size={14}/>Search</button></form>
    <div className="topbar-status">
      <button className="topbar-icon-button" type="button" aria-label="Refresh mailbox" title="Refresh mailbox" onClick={()=>void onSearch()}><Icon name="refresh" size={19}/></button>
      <button className={`topbar-icon-button notification-${notificationState}`} type="button" aria-label={notificationLabel(notificationState)} title={notificationLabel(notificationState)} disabled={notificationsDisabled} onClick={onToggleNotifications}><Icon name="bell" size={19}/>{notificationState==="on"?<i className="topbar-notification-dot" aria-hidden="true"/>:null}</button>
    </div>
  </header>;
}
