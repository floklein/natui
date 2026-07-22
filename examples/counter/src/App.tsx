import {
  Button,
  Divider,
  HStack,
  Image,
  Platform,
  Progress,
  Slider,
  Spacer,
  Text,
  TextField,
  Toggle,
  VStack,
  Window,
  useState,
} from "@natui/core";

interface StepButtonProps {
  label: string;
  onPress: () => void;
}

function StepButton({ label, onPress }: StepButtonProps) {
  return (
    <Button
      accessibilityLabel={`${label} one`}
      background="accent"
      cornerRadius={9}
      foreground="white"
      minWidth={88}
      onPress={onPress}
      padding={{ bottom: 8, leading: 14, top: 8, trailing: 14 }}
      title={label}
    />
  );
}

export default function App() {
  const [count, setCount] = useState(0);
  const [name, setName] = useState("Ada");
  const [enabled, setEnabled] = useState(true);
  const [progress, setProgress] = useState(0.42);
  const platformName = Platform.select({ macos: "macOS", windows: "Windows" });

  return (
    <Window height={620} title="NatUI Counter" width={520}>
      <VStack
        alignment="leading"
        background="#F5F2EA"
        minHeight={620}
        padding={28}
        spacing={18}
      >
        <HStack alignment="center" spacing={12}>
          <Image
            accessibilityLabel="Sparkles"
            foreground="accent"
            height={28}
            systemName="sparkles"
            width={28}
          />
          <VStack alignment="leading" spacing={2}>
            <Text fontSize={25} fontWeight="bold">
              React, rendered native
            </Text>
            <Text foreground="secondary" fontSize={13}>
              SwiftUI on macOS, WinUI on Windows
            </Text>
          </VStack>
        </HStack>

        <Divider />

        <Text foreground="secondary" fontSize={12} fontWeight="semibold">
          LIVE REACT STATE
        </Text>
        <HStack alignment="center" spacing={14}>
          <StepButton label="−" onPress={() => setCount((value) => value - 1)} />
          <Text fontSize={42} fontWeight="bold" minWidth={92} textAlign="center">
            {count}
          </Text>
          <StepButton label="+" onPress={() => setCount((value) => value + 1)} />
        </HStack>

        <VStack alignment="leading" spacing={8}>
          <Text fontWeight="semibold">Controlled native input</Text>
          <TextField onChange={setName} placeholder="Your name" value={name} />
          <Text foreground="secondary">
            Hello {name || "stranger"}, this is a native {platformName} view.
          </Text>
        </VStack>

        <Toggle label="Enable native notifications" onChange={setEnabled} value={enabled} />

        <VStack alignment="leading" spacing={8}>
          <HStack alignment="center" spacing={8}>
            <Text fontWeight="semibold">Progress</Text>
            <Spacer />
            <Text foreground="secondary">{Math.round(progress * 100)}%</Text>
          </HStack>
          <Slider maximum={1} minimum={0} onChange={setProgress} step={0.01} value={progress} />
          <Progress label="Completion" value={progress} />
        </VStack>

        <Spacer />
        <Text foreground="secondary" fontSize={11}>
          One TypeScript bundle, two native UI trees. No HTML or CSS.
        </Text>
      </VStack>
    </Window>
  );
}
