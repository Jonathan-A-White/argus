import { TriangleAlert } from 'lucide-react'

export function InlineError({ message }: { message: string }) {
  if (!message) return null
  return (
    <p className="workflow-error" role="alert">
      <TriangleAlert aria-hidden="true" />
      <span>{message}</span>
    </p>
  )
}
