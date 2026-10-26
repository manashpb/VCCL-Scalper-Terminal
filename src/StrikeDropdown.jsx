import React, {useId,useLayoutEffect,useRef,useState,useEffect} from 'react';
import {createPortal} from 'react-dom';
const key=i=>`${i.exchangeSegment}:${i.securityId}`;
export default function StrikeDropdown({type,options,value,onChange,spot}){
  const [open,setOpen]=useState(false),[active,setActive]=useState(0),[atm,setAtm]=useState(0),[position,setPosition]=useState({});
  const button=useRef(null),list=useRef(null),id=useId();
  const selected=options.find(i=>key(i)===value);
  function show(){
    if(!options.length)return;
    let nearest=0;const reference=spot||selected?.strike||options[0].strike;
    options.forEach((i,n)=>{if(Math.abs(i.strike-reference)<Math.abs(options[nearest].strike-reference))nearest=n;});
    const rect=button.current.getBoundingClientRect(),width=Math.min(Math.max(rect.width,180),innerWidth-24),height=Math.min(286,options.length*34+8);
    setPosition({width,left:Math.max(12,Math.min(rect.left,innerWidth-width-12)),top:rect.bottom+height+6<innerHeight?rect.bottom+6:Math.max(8,rect.top-height-6)});
    setAtm(nearest);setActive(Math.max(0,options.findIndex(i=>key(i)===value)));setOpen(true);
  }
  useLayoutEffect(()=>{if(open&&list.current)list.current.scrollTop=Math.max(0,atm*34-(list.current.clientHeight-34)/2+4);},[open]);
  useEffect(()=>{
    if(!open)return;
    const outside=e=>{if(!button.current?.contains(e.target)&&!list.current?.contains(e.target))setOpen(false);};
    const scroll=e=>{if(!list.current?.contains(e.target))setOpen(false);};
    const close=()=>setOpen(false);
    document.addEventListener('pointerdown',outside);window.addEventListener('resize',close);window.addEventListener('scroll',scroll,true);
    return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',close);window.removeEventListener('scroll',scroll,true);};
  },[open]);
  function choose(index){if(options[index])onChange(key(options[index]));setOpen(false);button.current?.focus();}
  function keyboard(e){
    if(e.key==='Escape'){setOpen(false);return;}
    if(e.key==='Tab'){setOpen(false);return;}
    if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
      e.preventDefault();if(!open){show();return;}
      const next=e.key==='Home'?0:e.key==='End'?options.length-1:Math.max(0,Math.min(options.length-1,active+(e.key==='ArrowDown'?1:-1)));
      setActive(next);list.current?.children[next]?.scrollIntoView({block:'nearest'});
    }
    if(e.key==='Enter'||e.key===' '){e.preventDefault();if(open)choose(active);else show();}
  }
  return <><button ref={button} className="strike-picker" role="combobox" aria-label={`${type} strike`} aria-expanded={open} aria-controls={open?id:undefined} aria-activedescendant={open?`${id}-${active}`:undefined} aria-haspopup="listbox" disabled={!options.length} onClick={()=>open?setOpen(false):show()} onKeyDown={keyboard}><span>{selected?.strike||'Select strike'}</span><span aria-hidden="true">⌄</span></button>{open&&createPortal(<div ref={list} id={id} role="listbox" aria-label={`${type} strikes around ATM`} className="strike-options" style={position}>{options.map((i,n)=><div key={key(i)} id={`${id}-${n}`} role="option" aria-selected={key(i)===value} className={`${key(i)===value?'chosen ':''}${n===active?'focused ':''}${n===atm?'atm':''}`} onPointerDown={e=>e.preventDefault()} onMouseMove={()=>setActive(n)} onClick={()=>choose(n)}><span>{i.strike}</span>{n===atm?<b>ATM</b>:<small>{n>atm?'+':''}{n-atm}</small>}</div>)}</div>,document.body)}</>;
}
