import { Overlay } from "@/src/design/Overlay";
import { useBuilder } from "../context/BuilderContext";
import { AssistantPane } from "../panes/AssistantPane";

export function AssistantSheet() {
  const b = useBuilder();
  const close = () => b.setAssistantOpenMobile(false);
  return <Overlay open={b.assistantOpenMobile} onClose={close} title="Quotation assistant" presentation="bottom" scroll={false} header={false} maxHeight={0.9}>
    <AssistantPane onClose={close} />
  </Overlay>;
}
