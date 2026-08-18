export function lectureListenHost(production: boolean): "0.0.0.0" | "127.0.0.1" {
  return production ? "0.0.0.0" : "127.0.0.1";
}
