/** "1 item", "2 items", "0 people": the one rule every count in the interface uses. */
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
