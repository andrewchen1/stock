import { useEffect } from 'react'
import { RouterProvider } from 'react-router-dom'
import { useStockColorStore } from '@/store/use-stock-color-store'
import { router } from './router'

export default function App() {
  const stockColor = useStockColorStore((state) => state.stockColor)

  useEffect(() => {
    if (stockColor === 1) {
      document.documentElement.classList.add('stock-color-inverse')
    } else {
      document.documentElement.classList.remove('stock-color-inverse')
    }
  }, [stockColor])

  return <RouterProvider router={router} />
}
