import { useEffect, useMemo, useRef, useState } from "react";

import api from "../apiClient";

import { getAuthHeaders } from "../utils/auth";

import { lookupProductByBarcode } from "../utils/barcode";

import CameraBarcodeButton from "./barcode/CameraBarcodeButton";

import { Icon } from "./ui";

import "./barcode/barcode-scanner.css";



let cache = null;

let cacheTime = 0;



async function loadProducts() {

  const now = Date.now();

  if (cache && now - cacheTime < 60000) return cache;

  const { data } = await api.get("/api/products", { headers: getAuthHeaders() });

  cache = data;

  cacheTime = now;

  return data;

}



/** Autocomplete product picker. onPick(product) called on selection. */

export default function ProductPicker({

  onPick,

  placeholder = "ابحث عن منتج بالاسم أو الباركود…",

  enableCamera = true,

}) {

  const [all, setAll] = useState([]);

  const [q, setQ] = useState("");

  const [open, setOpen] = useState(false);

  const [scanErr, setScanErr] = useState("");

  const ref = useRef(null);



  useEffect(() => {

    loadProducts().then(setAll).catch(() => {});

  }, []);



  useEffect(() => {

    const onDoc = (e) => {

      if (ref.current && !ref.current.contains(e.target)) setOpen(false);

    };

    document.addEventListener("mousedown", onDoc);

    return () => document.removeEventListener("mousedown", onDoc);

  }, []);



  const results = useMemo(() => {

    const term = q.trim().toLowerCase();

    if (!term) return [];

    return all

      .filter(

        (p) =>

          String(p.name).toLowerCase().includes(term) ||

          String(p.barcode).includes(term)

      )

      .slice(0, 20);

  }, [q, all]);



  async function handleCameraScan(code) {

    setScanErr("");

    try {

      const product = await lookupProductByBarcode(code);

      onPick(product);

      setQ("");

      setOpen(false);

    } catch (e) {

      setScanErr(e.message || "تعذّر البحث");

    }

  }



  return (

    <div ref={ref}>

      <div className="barcode-input-row">

        <div className="ui-search" style={{ position: "relative", flex: 1 }}>

          <Icon name="search" />

          <input

            className="ui-input"

            value={q}

            placeholder={placeholder}

            onChange={(e) => {

              setQ(e.target.value);

              setOpen(true);

              setScanErr("");

            }}

            onFocus={() => setOpen(true)}

          />

          {open && results.length > 0 && (

            <ul

              className="search-dropdown"

              style={{

                position: "absolute",

                insetInlineStart: 0,

                insetInlineEnd: 0,

                zIndex: 20,

              }}

            >

              {results.map((p) => (

                <li

                  key={p.id}

                  onClick={() => {

                    onPick(p);

                    setQ("");

                    setOpen(false);

                  }}

                >

                  <strong>{p.name}</strong>

                  <span

                    style={{

                      color: "var(--office-panel-muted)",

                      marginInlineStart: 8,

                    }}

                  >

                    {p.barcode} · مخزون {p.stock} · كلفة{" "}

                    {Number(p.cost).toFixed(2)}

                  </span>

                </li>

              ))}

            </ul>

          )}

        </div>

        {enableCamera ? (

          <CameraBarcodeButton onScan={handleCameraScan} />

        ) : null}

      </div>

      {scanErr ? <div className="barcode-scan-err">{scanErr}</div> : null}

    </div>

  );

}



export function invalidateProductCache() {

  cache = null;

}


