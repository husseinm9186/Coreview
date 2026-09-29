# Standard Normalized Capture Groups

To ensure predictable and consistent structured data across different templates and vendors, the community (specifically [ntc-templates](https://github.com/networktocode/ntc-templates)) encourages the use of normalized capture group names.

When creating new templates, please adhere to these standards to maintain compatibility with the broader ecosystem.

## Goals

1.  **Normalization**: Common capture groups should be named consistently across templates (including cross-vendor).
2.  **Predictability**: Reduces the programming logic needed to consume data when field names are standard.

## Common Capture Groups Reference

| Capture Group | Usage Description |
| :--- | :--- |
| `BIA` | Use this if the template already has `MAC_ADDRESS` in use for the active MAC address. |
| `BUNDLE_NAME` | Virtual interface name for etherchannel, LACP, LAG, or port-channel interfaces. |
| `BUNDLE_PROTOCOL` | Virtual interface protocol type (LACP, PAgP) for etherchannel or port-channel interfaces. |
| `BUNDLE_PROTOCOL_STATE` | Virtual interface protocol state for etherchannel or port-channel interfaces. |
| `BUNDLE_STATUS` | Virtual interface status for etherchannel, LACP, LAG, or port-channel interfaces. |
| `CAPABILITIES` | Often represents active/operational neighbor capabilities shared via CDP or LLDP. |
| `CAPABILITIES_SUPPORTED` | Often represents supported neighbor capabilities shared via CDP or LLDP. |
| `CHASSIS_ID` | Often represents CDP or LLDP neighbor chassis ID. |
| `DESCRIPTION` | Often used for port or interface descriptions. |
| `GATEWAY` | Gateway address for a subnet. |
| `INTERFACE` | Full word instead of IFACE, INTF, INTFC, etc. |
| `IP_ADDRESS` | For a single IP address, often IPv4. |
| `IP_ADDRESSES` | For lists of IPv4 addresses (sometimes mixed versions). |
| `IP_HELPER` | For lists of DHCP IP helper addresses. |
| `IP_VERSION` | IP version in the case of multiple versions appearing in output. |
| `IPV6_ADDRESS` | For a single IPv6 address. |
| `IPV6_ADDRESSES` | For lists of IPv6 addresses. |
| `IPV6_GATEWAY` | For IPv6 gateway address. |
| `LOCAL_INTERFACE` | Often represents local interface or port for CDP or LLDP. |
| `LOCAL_IP_ADDRESS` | Local IP address in the case of First Hop Redundancy Protocols (FHRP). |
| `MAC_ADDRESS` | Instead of MAC or MACADDR. |
| `MEMBER_INTERFACE` | List of physical member interface names bundled in an etherchannel/LAG. |
| `MEMBER_INTERFACE_STATUS` | List of member interface statuses for an etherchannel/LAG. |
| `MGMT_ADDRESS` | Management address, used when data could be Ethernet MAC or IP (ex: CDP or LLDP). |
| `MGMT_IP_ADDRESS` | Instead of MGMT_IP, MGMT_ADDRESS, MANAGEMENT_IP, etc. |
| `NEIGHBOR_DESCRIPTION` | Often represents CDP or LLDP neighbor or system name description. |
| `NEIGHBOR_ID` | For router IDs remote to the system being parsed. |
| `NEIGHBOR_INTERFACE` | Often represents neighbor or remote interface or port for CDP or LLDP. |
| `NEIGHBOR_INTERFACE_DESCRIPTION` | CDP or LLDP neighbor (remote host) interface or port descriptions. |
| `NEIGHBOR_NAME` | Often represents neighbor name for CDP or LLDP. |
| `NETMASK` | For IPv4 dotted quad masks. |
| `NETWORK` | For network numbers or subnet address (without mask); in place of ROUTE. |
| `PID` | Represents Part IDs (PIDs), SKUs, and in some cases Models. |
| `PLATFORM` | Often represents CDP or LLDP neighbor's platform or model name/number. |
| `PREFIX_LENGTH` | Instead of PREFIX or CIDR for the numbers of a slash notation or CIDR mask. |
| `PROTOCOL` | Instead of PROTO. |
| `ROUTER_ID` | For local router IDs (local to the device being parsed). |
| `SERIAL` | Represents serial numbers. |
| `VLAN_ID` | Numeric VLAN identifier; used instead of VLAN, VLANID, or TAG. |
| `VLAN_NAME` | VLAN name or description. |

## Considerations

*   **Single vs List**: Some groups are single values (e.g., `IP_ADDRESS`) while others are lists (e.g., `IP_ADDRESSES`) depending on the context, even if the data looks similar.
*   **Breaking Changes**: Renaming capture groups in existing templates changes the output structure and is considered a breaking change.
