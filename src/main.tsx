import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { createWalletRuntime } from './blockchain/walletRuntime'
import './styles.css'

// The runtime controller is composed inside App, after the identity gate unlocks a real device identity
// (or immediately, in mock-development); it is never constructed eagerly here.
const walletRuntime = createWalletRuntime(import.meta.env.VITE_ARGUS_BLOCKCHAIN_MODE)
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App walletStatusProvider={walletRuntime.wallet} />
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`))
}
